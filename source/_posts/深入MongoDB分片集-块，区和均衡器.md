---
title: 深入MongoDB分片集 - 块，区和均衡器
date: 2019-12-24 15:50:19
tags:
- MongoDB
- Database
- Distributed
- DevOps
- Optimization
categories:
- Database
thumbnail: "/images/banner/深入MongoDB分片集 - 块，区和均衡器.jpg"
typora-root-url: ../../source/
---

MongoDB提供一些机制来帮助我们控制数据在分片集上的分布。我们来讨论一下**块**(Chunk)，**区**(Zone)，**分片策略**和**均衡器**(Balancer)。

# Chunk

类似于操作系统中的存储粒度控制，MongoDB分片集均衡器在负载均衡时也不是直接以Document为单位的，而是加入了Chunk的概念。每个Chunk包含一定范围片键的数据，互不相交且并集为全部数据，即离散数学中**划分**的概念。

![](../images/%E6%B7%B1%E5%85%A5MongoDB%E5%88%86%E7%89%87%E9%9B%86-%E5%9D%97%EF%BC%8C%E5%8C%BA%E5%92%8C%E5%9D%87%E8%A1%A1%E5%99%A8/sharding-range-based.bakedsvg.svg)

MongoDB会在新数据插入后检查Chunk的大小，超出限制后会自动进行拆分，默认的限制为为64MB，单文档无法被拆分，因此单文档大小不能超过这一限制。

![](../images/%E6%B7%B1%E5%85%A5MongoDB%E5%88%86%E7%89%87%E9%9B%86-%E5%9D%97%EF%BC%8C%E5%8C%BA%E5%92%8C%E5%9D%87%E8%A1%A1%E5%99%A8/sharding-splitting.bakedsvg.svg)

如果我们观察到分片集内数据量很大，但都集中在某几个Chunk上，这可能是由于片键集中在某个范围内，并且单个数据体积较小，合并后没有超过单个Chunk的限制造成的。一个Chunk只会在一个分片上，因此我们的数据读写操作实际上并没有因为使用分片集而实现较好的负载均衡。这是我们可以人为干预Chunk的拆分过程。

MongoDB提供[split](https://docs.mongodb.com/manual/reference/command/split/#dbcmd.split)命令来手动拆分Chunk，在Mongo Shell中还提供工具函数[sh.splitFind()](https://docs.mongodb.com/manual/reference/method/sh.splitFind/#sh.splitFind)和[sh.splitAt()](https://docs.mongodb.com/manual/reference/method/sh.splitAt/#sh.splitAt)：

```javascript
// splitFind 将找到的第一个 Document 所在 Chunk 进行二等分
sh.splitFind("hw.foo", { bar: 1 });

// splitAt 将按找到 Document 的位置来对该块进行切分
sh.splitAt("hw.foo", { bar: 50 });
```

对应的，MongoDB也提供[mergeChunks](https://docs.mongodb.com/manual/reference/command/mergeChunks/#dbcmd.mergeChunks)来合并同一分片上连续的Chunk。

```javascript
// 通过 sh.status() 查看当前 Chunk 分布状况
// ...

// 通过指定上下界合并某一分片上的连续 Chunk
db.adminCommand({
   mergeChunks: "hw.foo",
   bounds: [{ "bar" : 0 },
            { "bar" : 100 }]
});
```

# Sharding 策略

Sharding 策略规定了数据应当处于哪一个分片上。MongoDB 提供两种 Sharding 策略：

## Hashed Sharding

这种策略首先根据片键计算哈希，再根据此哈希的**范围**确定分片。这种策略的好处是即使数据的片键分布不均匀，比如集中在某个小范围，他们最终也会因为哈希值的差异而分布在不同Chunk上，进而可能处于不同分片上，使数据在整个分片集上更加均匀。

这种策略的弊端则在于，对于基于片键范围的查询，Mongos无法确定数据必定分布于哪几个分片上，因此不得不进行**广播**(Broadcast Operation)。

![sharding-hash-based.bakedsvg](../images/%E6%B7%B1%E5%85%A5MongoDB%E5%88%86%E7%89%87%E9%9B%86-%E5%9D%97%EF%BC%8C%E5%8C%BA%E5%92%8C%E5%9D%87%E8%A1%A1%E5%99%A8/sharding-hash-based.bakedsvg.svg)

值得注意的是，MongoDB的这种Hashed Sharding，本质上仍然是基于范围的的分片策略，与分布式概念中的哈希分布并不是相同的概念。

## Ranged Sharding

这种策略直接根据片键的范围确定分片。优缺点与Hashed Sharding相反，即如果片键分布不均匀，则数据会集中个别节点上。但Mongos能够根据查询中的片键上下界确定分片范围，而无需广播。

![sharding-range-based.bakedsvg](../images/%E6%B7%B1%E5%85%A5MongoDB%E5%88%86%E7%89%87%E9%9B%86-%E5%9D%97%EF%BC%8C%E5%8C%BA%E5%92%8C%E5%9D%87%E8%A1%A1%E5%99%A8/sharding-range-based.bakedsvg-7256720.svg)

# Zone

简单来说Zone实际上像是一种标签选择机制(在MongoDB命令中也确实被称为Tag)，你为一定范围内的片键制定一个Zone，然后再将一些分片加入到这个Zone中，于是这一范围内的数据最终就将存储在这个Zone中的分片上。由此也容易看出，Zone指定的范围不能有交集。

分片内的均衡器在分片间移动Chunk时，范围内的数据仅会在同一Zone的分片间移动，以保证分布的合法性，对于那些没有被Zone限制的Chunk，则可能出现在任意分片上。

![Diagram of data distribution based on zones in a sharded cluster](../images/%E6%B7%B1%E5%85%A5MongoDB%E5%88%86%E7%89%87%E9%9B%86-%E5%9D%97%EF%BC%8C%E5%8C%BA%E5%92%8C%E5%9D%87%E8%A1%A1%E5%99%A8/sharded-cluster-zones.bakedsvg.svg)

```javascript
// 将分片添加进一个Zone
sh.addShardTag('hlshardsvr0', 'US');
sh.addShardTag('hlshardsvr1', 'EU');
sh.addShardTag('hlshardsvr1', 'EU');
// 为Zone指定范围
sh.addTagRange('hw.foo', { bar: 0 }, { bar: 1024 }, 'US');
sh.addTagRange('hw.foo', { bar: 1024 }, { bar: 2048 }, 'EU');
// 查看Zone
use config;
db.shards.find({ tags: 'US' });
```

比如在[官方文档](https://docs.mongodb.com/manual/tutorial/sharding-segmenting-data-by-location/)上的例子就利用Zone来实现了一个基于地理位置的分片控制，将北美注册的用户引导至位于北美的Zone分片上，欧洲注册的用户引导至位于欧洲的Zone分片上，从而提升了集群的响应速度和容错性。

![](../images/%E6%B7%B1%E5%85%A5MongoDB%E5%88%86%E7%89%87%E9%9B%86-%E5%9D%97%EF%BC%8C%E5%8C%BA%E5%92%8C%E5%9D%87%E8%A1%A1%E5%99%A8/sharding-segmenting-data-by-location-overview.bakedsvg.svg)

# Balancer

Balancer是MongoDB的一个运行在Config Server的Primary节点上(自MongoDB 3.4版本起)的后台进程，它监控每个分片上Chunk数量，并在某个分片上Chunk数量达到阈值进行迁移。迁移过程对于应用是透明的，但由于迁移过程会占用相应节点的CPU和带宽资源，因此对分片集有一定程度的性能影响，并且对运维操作存在一些限制。

当某一分片上的Chunk数量过多，超过一定阈值时，**均衡器**(Balancer)会自动进行Chunk在Shard间的迁移，尝试在一定约束下(如前文提到的Zone)使各个Shard上Chunk的数量保持均衡。均衡器对待自动和手动拆分产生的新Chunk是一致的，在块拆分行为影响到后续插入操作时倾向于将新产生的Chunk立即迁移到其他分片上。

![](../images/%E6%B7%B1%E5%85%A5MongoDB%E5%88%86%E7%89%87%E9%9B%86-%E5%9D%97%EF%BC%8C%E5%8C%BA%E5%92%8C%E5%9D%87%E8%A1%A1%E5%99%A8/sharding-migrating.bakedsvg.svg)

更具体的来说，当Balancer找到包含更多Chunk的**源分片**和包含更少Chunk的**目标分片**后：

- Balancer向源分片发送[moveChunk](https://docs.mongodb.com/manual/reference/command/moveChunk/#dbcmd.moveChunk)命令。
- 源分片收到这一请求后开始迁移操作，迁移期间对该Chunk中数据的读写操作仍然会被路由到源分片。
- 目标分片构建索引。
- 目标分片获取截至迁移开始时源分片上该Chunk的数据。
- 目标分片与源同步迁移开始时后变化的内容。
- 目标分片向Config Server发送请求，更新元数据。
- 当源分片上对应Chunk不存在打开的Cursor之后，该Chunk会被删除(如果开启了sharding.archiveMovedChunks则会被归档)。

当我们向分片集加入或从分片集中移除(执行[removeShard](https://docs.mongodb.com/manual/reference/command/removeShard/#dbcmd.removeShard)但没有断开节点的连接)一个Shard时，Balancer会进行迁移以达到新的平衡。如果我们要进行分片集的备份，则应先确保没有迁移动作正在执行，然后关闭Balancer后操作，否则可能得到一个状态不一致的备份。

下面的代码块展示了对Balancer的基本操作：

```javascript
// 查看 Balancer 是否被启用
sh.getBalancerState();
true

// 查看 Balancer 是否正在运行
sh.isBalancerRunning();
false

// 启用 Balancer
sh.startBalancer();

// 关闭 Balancer
sh.stopBalancer();

// 设置可以进行 Chunk 迁移的时间(每天凌晨 1 点到 5 点)
// 设置迁移时间窗口后，不要手动执行 sh.startBalancer()。
use config
db.settings.updateOne(
  { _id: "balancer" },
  { $set: { activeWindow: { start: "01:00", stop: "05:00" } } },
  { upsert: true }
);

// 移除迁移时间窗口
db.settings.updateOne(
	{ _id: "balancer" },
  { $unset: { activeWindow: "" } },
);

// 如果需要进行备份，需要保证以下状态为 true
!sh.getBalancerState() && !sh.isBalancerRunning();

// 关闭指定集合上的迁移
sh.disableBalancing("hw.foo");

// 获取指定集合的迁移状态，若返回 true，则迁移被关闭
db.getSiblingDB("config")
  .collections.findOne({ _id: "hw.foo" })
  .noBalance;


// 开启指定集合上的迁移
sh.enableBalancing("hw.foo")；
```

与Chunk的拆分和合并类似，Chunk的迁移也可以进行人为干预，如下述场景：

- 在批量操作前对空集合进行预分布。
- 在迁移时间窗口内Balancer没有完成全部的迁移工作，并且当前的Chunk分布情况影响到了分片集的读写性能。

手动Chunk迁移使用[moveChunk](https://docs.mongodb.com/manual/reference/command/moveChunk/#dbcmd.moveChunk)命令，举例：

```javascript
// 将包含片键 bar = 1 的 Chunk 移动至 hlshardsvr1 分片
db.adminCommand({
	moveChunk: "hw.foo",
	find: { bar: 1 },
	to: "hlshardsvr1"
});
```

# 总结

了解MongoDB对数据在分片集上如何分布的更多细节有利于对MongoDB性能调优和各场景下的限制有更深入的理解。从大的角度来说，MongoDB的横向扩容方案与其他数据库类似，因此也存在其他产品相应的问题，如Shuffle的性能，分布式事务的性能，有机会的话我会在后续的文章中讨论。