---
title: MongoDB的高可用和横向扩容方案
date: 2019-12-24 15:48:47
tags:
- MongoDB
- Database
- Distributed
- DevOps
- Optimization
categories:
- Database
thumbnail: "/images/banner/MongoDB的高可用和横向扩容方案.jpg"
typora-root-url: ../../source/
---

数据密集型应用通常需要存储海量数据，并且要保证容量的提升不会带来显著的读写性能和数据安全性的下降。与目前主流的分布式数据存储方案一致，MongoDB也通过复制集(Replica Set)和分片集(Sharding)来实现高可用和横向扩展。

# 复制集

一个复制集实际上是一组管理相同数据的Mongod进程，其目的在于以冗余为代价实现高可用，为生产环境部署提供了基础。

## 节点职能

在一个复制集中，存在一个**主节点(Master)**，若干个**从节点(Slave)**，和可选的**选举(仲裁，Arbiter)节点**。从节点中存储的数据来自主节点，是主节点数据的**只读**冗余备份，对于这份冗余数据，可以用来做审计/备份任务，也可以用来分担一些主节点的读压力。

主节点可以接受读/写请求，当主节点收到写请求时，会同时将记录日志到oplog并根据WriteConcern策略同步到从节点并返回。

![](../images/MongoDB%E7%9A%84%E9%AB%98%E5%8F%AF%E7%94%A8%E5%92%8C%E6%A8%AA%E5%90%91%E6%89%A9%E5%AE%B9%E6%96%B9%E6%A1%88/replica-set-read-write-operations-primary.bakedsvg.svg)

从节点会同步oplog的操作到自身持有的数据，并在主节点挂掉的时候参与选举，一个合格的从节点可能在选举后升为主节点。MongoDB复制集与很多选举集群一样，在存活节点少于总结点数的一半时便不再选举主节点，从而整个集群只对外提供读服务。考虑到这一特性，通常集群节点数会被设置为奇数，因为从容错性上考虑，设置为2n何设置为2n-1的效果是一致的。也因此，在MongoDB复制集中还存在一种选举节点，这种节点不持有数据，但可以参与选举，占用的资源很小，却可以在某些场景中提升集群的容错性。

![](../images/MongoDB%E7%9A%84%E9%AB%98%E5%8F%AF%E7%94%A8%E5%92%8C%E6%A8%AA%E5%90%91%E6%89%A9%E5%AE%B9%E6%96%B9%E6%A1%88/replica-set-trigger-election.bakedsvg.svg)

复制集在选举过程中，由于不存在主节点，因此无法对外提供写服务。由于从主节点读取数据是一个异步的过程，因此实际上从节点开放的读能力并不严格保证数据的一致性，同时，对于MongoDB 4.0版本提供的多文档事务，也要求必须从主节点读取数据。

# 分片集

当数据量非常大的时候，MongoDB允许我们把数据以分片(Shard)的方式存储在多台机器上，以分解服务器在CPU，内存和磁盘IO方面的压力。

一个MongoDB分片集包含3个部分：

1. 分片：每个分片储存一定量的数据，分片可以被配置为复制集。
2. Mongos：作为客户端与集群间的路由器，转发请求至分片。
3. Config Server：存储集群配置与元数据，为保证高可用必须被配置为复制集。

其大致结构如下图：

![](../images/MongoDB%E7%9A%84%E9%AB%98%E5%8F%AF%E7%94%A8%E5%92%8C%E6%A8%AA%E5%90%91%E6%89%A9%E5%AE%B9%E6%96%B9%E6%A1%88/sharded-cluster-production-architecture.bakedsvg.svg)

MongDB分片以集合(Collection)为粒度，可以配置在某些集合上使用分片特性。

## 存储方式

MongoDB使用**片键(Shard Key)**来决定在哪一个分片上存储和查找一条数据，片键可以人为指定，但必须是不可变字段且这一字段存在于所有文档(Document，即MongoDB存储的单条数据)中。每个分片集合上只能存在一个(复合)片键，一旦分片，则片键无法再修改。片键的选择很可能成为决定性能的瓶颈，我们通常选择那些带有索引的字段作为片键。

MongoDB将分片数据拆分为**块(Chunk)**，每个块包含一定片键范围的数据。为了使块能够均匀的分布在各个分片上，MongoDB会有一个后台的均衡器来在分片间迁移块。

分片集合的数据被存储在不同的机器上，而没有配置分片集的集合中的数据都存储在同一个主分片上，每个数据库(Database)都有自己对应的主分片，主分片和复制集中的主节点并没有直接的关系，主分片可以手动通过movePrimary命令切换，切换将引起数据迁移，迁移期间数据无法访问。

![](../images/MongoDB%E7%9A%84%E9%AB%98%E5%8F%AF%E7%94%A8%E5%92%8C%E6%A8%AA%E5%90%91%E6%89%A9%E5%AE%B9%E6%96%B9%E6%A1%88/sharded-cluster-primary-shard.bakedsvg.svg)

## 优势

**读写负载均衡**。某些情况下，Mongos可以根据片键推算出当前读写操作对应的数据只可能影响到某一个分片，从而只向对应分片转发请求，降低了其他分片的负载。

**存储容量**。由于数据分布在多个机器上，从而扩大了整个数据库的容量。

**高可用**。当某个分片挂掉的时候，对于其他分片上数据的请求仍能正常返回。

## 分片策略

### 哈希分片

顾名思义，即基于片键的哈希值决定分片位置。这种方式的优势在于默认的哈希函数具有随机性，即使非常接近的片键也很有可能被分配到完全不同的分片上，因此最终数据比较均匀。但也因此存在相应的弊端，即对于基于范围的遍历操作不得不被“广播”到所有分片上，影响了操作的效率。

![](../images/MongoDB%E7%9A%84%E9%AB%98%E5%8F%AF%E7%94%A8%E5%92%8C%E6%A8%AA%E5%90%91%E6%89%A9%E5%AE%B9%E6%96%B9%E6%A1%88/sharding-hash-based.bakedsvg.svg)

### 基于范围分片

基于范围的分片会根据片键的范围决定数据存储的位置，片键相邻的数据大多存储在同一个分片上，解决了基于哈希分片的弊端。但如果数据片键分布不均匀，则这种分片方式的结果会导致存储上也不均匀。

![](../images/MongoDB%E7%9A%84%E9%AB%98%E5%8F%AF%E7%94%A8%E5%92%8C%E6%A8%AA%E5%90%91%E6%89%A9%E5%AE%B9%E6%96%B9%E6%A1%88/sharding-range-based.bakedsvg.svg)

## 搭建过程

下面我们搭建一个用于**开发/测试**环境的结构的分片集，即一个Router(mongos)，一个Config Server(ReplSet)和一个分片(mongod进程(3.6以前)或ReplSet)。

![](../images/MongoDB%E7%9A%84%E9%AB%98%E5%8F%AF%E7%94%A8%E5%92%8C%E6%A8%AA%E5%90%91%E6%89%A9%E5%AE%B9%E6%96%B9%E6%A1%88/sharded-cluster-test-architecture.bakedsvg.svg)

Config Server必须被配置为复制集，其中存储了集群的元数据，比如集群的结构，块分布，锁和鉴权配置等，保证请求路由被分配至正确的分片上。每个Config Server对应一个分片集，不能共享。如果Config Server复制集中的大部分节点挂掉，复制集变为只读，此时分片集仍能正常对外提供读写服务，但不会发生块迁移等修改Meta的事件直至Config Server恢复并选举出新的主节点。

mongos负责将请求路由到正确的分片，应用只有通过mongos才能正确的访问所有数据，直接连接分片将导致既能看到分片内的部分数据。在获取请求后，mongos根据请求条件和Config Server中的元数据决定应当把请求路由到哪些分片(eg. 根据请求中对应的片键确定仅需要把此请求转发给对应范围的分片，或将无法判断的请求(不包含片键)的请求广播给所有分片)并返回结果游标，排序等消耗资源的操作也会在分片上完成，因此mongos仅消耗较少的资源。

通常，updateMany和deleteMany等操作会被广播。

![无片键查询，广播](../images/MongoDB%E7%9A%84%E9%AB%98%E5%8F%AF%E7%94%A8%E5%92%8C%E6%A8%AA%E5%90%91%E6%89%A9%E5%AE%B9%E6%96%B9%E6%A1%88/sharded-cluster-scatter-gather-query.bakedsvg.svg)

所有insertOne，updateOne，replaceOne和deleteOne操作(这些操作要求必须包含片键或_id，否则报错)仅被路由至正确的分片。

![可以根据片键得到目标分片](../images/MongoDB%E7%9A%84%E9%AB%98%E5%8F%AF%E7%94%A8%E5%92%8C%E6%A8%AA%E5%90%91%E6%89%A9%E5%AE%B9%E6%96%B9%E6%A1%88/sharded-cluster-targeted-query.bakedsvg.svg)

连接到MongoDB后，通过db.runCommand({ isMaster: 1 })的返回数据来判断是分片集还是单实例，若返回值得msg信息为isdbgrid，则为分片集。运行sh.shardCollection(database.collection, key)可以将一个集合进行分片，其中key为分片集，如果对应的集合为空集，则会为key自动创建索引，否则必须手动。仅有片键支持unique索引。

首先，分别以复制集的形式启动一个Config Server和两个分片：

```shell
// 建立数据目录，hw随便起的，这里代表hello-world
mkdir C0{1,2,3} S0{1,2,3} S1{1,2,3}
// 启动Config Server(复制集)
mongod --configsvr --replSet "hlcfgsvr" --bind_ip localhost --port 8801 --dbpath ./C01
mongod --configsvr --replSet "hlcfgsvr" --bind_ip localhost --port 8802 --dbpath ./C02
mongod --configsvr --replSet "hlcfgsvr" --bind_ip localhost --port 8803 --dbpath ./C03
// 启动分片1(复制集)
mongod --shardsvr --replSet "hlshardsvr0" --bind_ip localhost --port 8901 --dbpath ./S01
mongod --shardsvr --replSet "hlshardsvr0" --bind_ip localhost --port 8902 --dbpath ./S02
mongod --shardsvr --replSet "hlshardsvr0" --bind_ip localhost --port 8903 --dbpath ./S03
// 启动分片2(复制集)
mongod --shardsvr --replSet "hlshardsvr1" --bind_ip localhost --port 8911 --dbpath ./S11
mongod --shardsvr --replSet "hlshardsvr1" --bind_ip localhost --port 8912 --dbpath ./S12
mongod --shardsvr --replSet "hlshardsvr1" --bind_ip localhost --port 8913 --dbpath ./S13
// 连接至Config Server
mongo --port 8801
// 初始化Config Server复制集
mongo> rs.initiate(
  {
    _id: "hlcfgsvr",
    configsvr: true,
    members: [
      { _id: 0, host: "localhost:8801" },
      { _id: 1, host: "localhost:8802" },
      { _id: 2, host: "localhost:8803" }
    ]
  }
);
// 查看复制集状态并退出
hlcfgsvr:SECONDARY> rs.status();
hlcfgsvr:PRIMARY> exit;
// 连接至分片1
mongo --port 8901
// 初始化分片1复制集
mongo> rs.initiate(
  {
    _id: "hlshardsvr0",
    members: [
      { _id: 0, host: "localhost:8901" },
      { _id: 1, host: "localhost:8902" },
      { _id: 2, host: "localhost:8903" }
    ]
  }
);
// 查看复制集状态并退出
hlshardsvr0:SECONDARY> rs.status();
hlshardsvr0:PRIMARY> exit;
// 连接至分片2
mongo --port 8911
// 初始化分片2复制集
mongo> rs.initiate(
  {
    _id: "hlshardsvr1",
    members: [
      { _id: 0, host: "localhost:8911" },
      { _id: 1, host: "localhost:8912" },
      { _id: 2, host: "localhost:8913" }
    ]
  }
);
// 查看复制集状态并退出
hlshardsvr1:SECONDARY> rs.status();
hlshardsvr1:PRIMARY> exit;
```

启动一个mongos，指定Config Server。并添加各个分片。

```shell
// 启动mongos
mongos --configdb hlcfgsvr/localhost:8801,localhost:8802,localhost:8803 --bind_ip localhost --port 9001
// 添加分片1
mongos> sh.addShard("hlshardsvr0/localhost:8901,localhost:8902,localhost:8903");
// 添加分片2
mongos> sh.addShard("hlshardsvr1/localhost:8911,localhost:8912,localhost:8913");
// 在数据库上启用分片
mongos> sh.enableSharding('hw');
// 查看分片集状态
mongos> sh.status();
// 在集合foo上，以bar为片键，以哈希的方式分片
mongos> sh.shardCollection('hw.foo', { bar: 'hashed' });
```

现在我们已经建立了分片集，插入一些数据查看效果：

```javascript
// 插入数据
use hw;
for (let i = 0; i < 1024; ++i) db.foo.insertOne({bar: i});
// 查询数据内容与数量
db.foo.find().pretty();
db.foo.count();
```

为了验证数据分布在不同分片上，我们分别用Mongo Shell直连其中一个分片，查看数据量：

```shell
mongo --port 8901
hlshardsvr0:PRIMARY> use hw;
hlshardsvr0:PRIMARY> db.foo.find().pretty();
hlshardsvr0:PRIMARY> db.foo.count();
```

# 总结

复制集和分片集在一定程度上使海量数据的存储和查询成为了可能，但也增加了运维的成本和功能特性上的限制，对于MongoDB来说，单个集合的分片是一个不可逆的过程，对于是否使用分片集，分片策略等问题应当针对具体业务仔细斟酌，而非盲目使用。后续文章会对MongoDB在分布式场景下的更多特性做更加深入的研究。