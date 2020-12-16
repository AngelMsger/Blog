---
title: 部署 Redis Sentinel
date: 2019-08-08 22:37:43
tags:
- Redis
- DevOps
categories:
- Database
thumbnail: "/images/banner/部署Redis Sentinel.jpg"
typora-root-url: ../../source/
---
Redis Sentinel为Redis提供了高可用方案. 可以在无人为干预的情况下容忍一定程度的错误, 宏观的说, Redis Sentinel实现了以下功能:
1. 监控: Sentinel检查Master/Slave(听说因为此称谓带有"奴隶"字样而被起诉, 未来会改名2333) 是否正常工作.
2. 提醒: 当Redis实例挂掉的时候, Sentinel可以通过一定方式通知运维人员.
3. 容错: 当Master挂掉的时候, Sentinel可以通过一系列神奇的操作为集群选举新的Master, 并将其他Slave和连接重新配置到新Master上.
4. 服务发现/配置提供: Sentinel可以充当一个服务发现节点, 向消费者提供可用的Redis实例地址.

Sentinel 本身也由多个分布式进程组成, 由此可以带来以下好处:
1. 只有多个Sentinel都无法与Master通信时才判定其已失效, 降低了误判的风险.
2. Sentinel本身在少数节点挂掉时仍能正常服务, 提升了容错性.

# 起步

## 获取
通常, 通过系统的包管理器安装Redis或直接从Redis官网下载的预编译二进制包已经集成了 Sentinel.

```shell
# Using Pacman on ArchLinux
sudo pacman -S redis

# Using Homebrew on MacOS
brew install redis

# Test Installation
redis-sentinel -v
Redis server v=5.0.2 sha=00000000:0 malloc=libc bits=64 build=6fc0f5745dcba2c3
```

当前的Sentinel版本为Sentinel 2, 它使用下文将提到的更为简单且健壮的算法重新实现了最初的版本, 并在自Redis 2.8版本后被集成在发行包中, 而自Redis 2.6版本开始提供的最初版本目前已被废弃.

## 运行
首先需要创建一个配置文件. Sentinel依赖此配置文件来记录状态并在重启时恢复, 因此此文件必须可写, 如果不提供一个合法的配置文件路径, Sentinel会拒绝启动, 此处我们先创建一个空文件用以测试, 稍后我们将讨论 Sentinel 的配置. 你可以通过两种方式启动Sentinel, 效果相同:

```shell
touch ./sentinel.conf
redis-sentinel ./sentinel.conf
...
^C
redis-server ./sentinel.conf --sentinel
...
```

Sentinel启动后会监听26379端口, 因此此接口不能被占用并应保证接下来能够正常访问.

## 部署
### 注意事项

1. 一个高可用的系统至少需要3个Sentinel实例部署在稳定性相对独立的宿主环境中(原因和其他集群一样).
2. 由于Redis复制集的异步性, Sentinel + Redis组合并不能保证在一次失败期间写入的数据能够完整的保留.
3. Sentinel模式对客户端不是透明的, 即需要客户端的支持.
4. 对于使用Docker或其他端口转发的环境的用户需要特别注意, 端口重映射会影响Sentinel实例发现其他Sentinel实例和Redis主从实例, 因此Sentinel或者说Redis与Docker协同工作时请务必仔细阅读下文中将提到的相关内容.

### 配置

Redis的发行包中已经附带了一个注释详尽的自说明的配置文件sentinel.conf文件, 此处使我们使用一个简化的配置文件:

```shell
sentinel monitor mymaster 127.0.0.1 6379 2
sentinel down-after-milliseconds mymaster 60000
sentinel failover-timeout mymaster 180000
sentinel parallel-syncs mymaster 1

sentinel monitor resque 192.168.1.3 6380 4
sentinel down-after-milliseconds resque 10000
sentinel failover-timeout resque 180000
sentinel parallel-syncs resque 5
```

在配置时, 一个Redis复制集仅需指定Master节点即可, Slave节点会被自动发现和配置, 不同的复制集必须各自有唯一的名称. Sentinel会在配置文件中保留集群状态信息用以在出错后恢复. 配置文件会在Redis集群每次重新选举Master或发现了新的Sentinel实例时被更新.

在上述例子中, Sentinel监控了两个Redis复制集, 每个复制集由一个Master节点和不确定个Slave实例组成, 并将其中一个复制集命名为mymaster, 另一个命名为resque. 对于命令monitor的选项配置如下:

```shell
sentinel monitor <master-group-name> <ip> <port> <quorum>
```

也就是配置文件的第一行实际指出了监控一个名为mymaster的复制集, 其Master节点当前的IP为127.0.0.1, 端口为6379, 仲裁数为2. 关于仲裁数这里需要展开说明一下, 这个数字定义了需要多少Sentinel节点与Master失联才判定为Master已失效从而开启一轮故障迁移(为集群选举新的Master并将其信息告诉尝试连接的客户端等), 但这个数字必须大于Sentinel集群实例的一半, 换言之, 必须是Sentinel集群中的绝大多数认同的失败才会引起故障迁移.

### 其他参数

对于上述示例配置文件, 下方几个命令起到了如下作用:

* down-after-milliseconds指定了Sentinel能够接受的各复制集Master最长的失联时间, 单位为毫秒, 如果超出这个时间Sentinel仍不能连接到Master, 则Sentinel会标记此Master已经失效并触发后续行为.
* parallel-syncs指定了最多有多少个Slave节点可以在同一时间从Master节点同步数据, 数字越小则同步时间所需越长. 如果你能够接受主从数据在短时间内不同步但不能接受有从节点无法对外服务, 则应当把这个参数设置的尽量小. 尽管从Master节点同步数据通常是异步且不阻塞Slave节点对外服务的, 但有大量数据需要同步时Slave节点仍有可能不得不短暂的暂停服务以完成对数据的加载.

更多配置命令可以参考官方文档的API部分. 所有的配置命令除了在配置文件中写入外都支持在Sentinel实例运行时通过SENTINEL SET命令进行修改.

## 基础使用
下面演示Sentinel实例的几个常用操作:

查看集群Master实例信息:

```shell
redis-cli -p 26379
127.0.0.1:26379> sentinel master mymaster
 1) "name"
 2) "mymaster"
 3) "ip"
 4) "127.0.0.1"
 5) "port"
 6) "6379"
 7) "runid"
 8) "953ae6a589449c13ddefaee3538d356d287f509b"
 9) "flags"
10) "master"
...
```

查看集群其他实例信息:

```shell
redis-cli -p 26379
127.0.0.1:26379> sentinel slaves mymaster
...
127.0.0.1:26379> sentinel sentinels mymaster
```

客户端寻找集群当前的Master节点:

```shell
redis-cli -p 26379
127.0.0.1:26379> SENTINEL get-master-addr-by-name mymaster
1) "127.0.0.1"
2) "6379"
```

验证一次故障迁移:

```shell
redis-cli -p 6379 DEBUG sleep 30
redis-cli -p 26379
127.0.0.1:26379> SENTINEL get-master-addr-by-name mymaster
1) "127.0.0.1"
2) "6379"
```

此外, Sentinel还支持动态配置集群信息, 调整集群结构, 通过Pub/Sub的方式监控集群故障迁移行为等功能.

# 部署演示
下面我们使用几个 ASCII图来简单的演示Sentinel的在几种情形下的部署结构, 首先来解释一下图例. 我们使用方框代表一台物理/虚拟机器:

>      +--------------------+
>      | This is a computer |
>      | or VM that fails   |
>      | independently. We  |
>      | call it a "box"    |
>      +--------------------+

在机器中运行一些服务:

>      +-------------------+
>      | Redis master M1   |
>      | Redis Sentinel S1 |
>      +-------------------+

机器间的线表名他们之间彼此互通:

>      +-------------+               +-------------+
>      | Sentinel S1 |---------------| Sentinel S2 |
>      +-------------+               +-------------+

网络分区或故障则被描述为:

>      +-------------+                +-------------+
>      | Sentinel S1 |------ // ------| Sentinel S2 |
>      +-------------+                +-------------+

此外值得注意的是:

* Master实例被标记为 M1, M2, M3, ..., Mn.
* Slave实例被标记为 R1, R2, R3, ..., Rn (R代表Replica).
* Sentinel实例被标记为 S1, S2, S3, ..., Sn.
* 客户端被标记为C1, C2, C3, ..., Cn.
* 当实例的状态或其在集群中的角色发生变化时, 我们用方括号标识. 如[M1]代表由于Sentinel的介入, 一个实例的身份变为Master.

## 基础的三节点集群
对于一个非常简单的集群, 通常至少需要3个节点(若为2, 则任一节点挂掉后都无法实现"绝大多数仍存活"这一基本条件, 集群无法继续对外服务, 因此实际上与 1 个节点一样不具备容错性). 我们接下来演示在3台机器上部署集群, 每台机器上各运行一个Sentinel实例和一个普通Redis实例.

>             +----+
>             | M1 |
>             | S1 |
>             +----+
>                |
>      +----+    |    +----+
>      | R2 |----+----| R3 |
>      | S2 |         | S3 |
>      +----+         +----+
>
>      Configuration: quorum = 2

当M1挂掉的时候, S2和S3都将认同M1的连接已丢失这一事实, 从而触发一次故障前一, 接下来客户端的连接将被导向原从节点中的一个. 由于Redis复制集的异步性, 在故障迁移过程中都有可能会丢失少量的已写入数据. 如下图所示, 由于客户端C1在未了解到集群状态变化时尝试将数据写入已丢失的分区内的Redis实例而导致其数据丢失:

>               +----+
>               | M1 |
>               | S1 | <- C1 (writes will be lost)
>               +----+
>                  |
>                  /
>                  /
>      +------+    |    +----+
>      | [M2] |----+----| R3 |
>      | S2   |         | S3 |
>      +------+         +----+

在这种情况下由于网络原因使得原Master节点被孤立, 原Slave节点升级为Master节点. 一旦M1从故障中恢复, 其将降级为Slave节点并尝试与新的Master节点同步数据, 这将导致故障期间来自客户端C1的写入永久丢失. 这一现象可以通过配置Redis实例在检测到已写入数据无法同步到指定数量的Slave节点时拒绝写入请求的方式来缓解:

```
min-slaves-to-write 1
min-slaves-max-lag 10
```

以上配置(详情可以查看自说明配置文件 redis.conf)制定了Redis实例作为Master角色时, 如果不能讲写入结果同步到至少一个Slave实例上时将拒绝写入请求, 由于数据同步本身是异步的, 因此需要另一个参数指出超出多长时间没有收到来自Slave实例的确认时判定为网络故障.

## 将Sentinel部署到客户端
当我们仅有两个主机分别部署了Master实例和Slave实例时, 上述方法不适用, 则此时我们可以将Sentinel实例部署到客户端服务器上(广义的客户端, 比如对外服务的Web Server, 不是真正用户d端).

>            +----+         +----+
>            | M1 |----+----| R1 |
>            |    |    |    |    |
>            +----+    |    +----+
>                      |
>         +------------+------------+
>         |            |            |
>         |            |            |
>      +----+        +----+      +----+
>      | C1 |        | C2 |      | C3 |
>      | S1 |        | S2 |      | S3 |
>      +----+        +----+      +----+
>
>      Configuration: quorum = 2

在这种配置下, Sentinel实例的视角与客户端相同, 如果Master实例对于绝大多数客户端是可见的, 那么Sentinel同样可见, 此时集群是正常服务的. 如果M1和S1服务挂了, 故障迁移流程将正常被触发, 不过显而易见, 在各种可能的错误下, 不同的网络分区导致的结果也对应着很多种结果, 如果所有客户端与所有Redis实例服务端间的网络断开了, 网络将无法正常对外服务.

## 更少的客户端
如果你也没有三台客户端服务器, 那么上面这种结构也不适用, 不妨试试下面这样:

>      +----+         +----+
>      | M1 |----+----| R1 |
>      | S1 |    |    | S2 |
>      +----+    |    +----+
>                |
>         +------+-----+
>         |            |
>         |            |
>      +----+        +----+
>      | C1 |        | C2 |
>      | S3 |        | S4 |
>      +----+        +----+
>
>      Configuration: quorum = 3

这种结构在客户端/服务端都部署了Sentinel实例, 可以看出在M1实例意外挂掉后其余节点仍能正常的完成一次故障迁移. 你可能觉得节点数量还可以再减少, 比如我们只有一个客户端服务器, 并且也能完成故障迁移程序, 毕竟我们仍有3个节点. 这当然是可以的, 只不过即使是客户端大多时候我们也会作高可用处理, 1个节点当然不太好啦.

# Sentinel在Docker或NAT下可能的问题
Docker使用端口映射技术, 使得服务实际对外暴露的端口与服务本身所认为开启的端口可能并不相同, 此项技术允许在同一宿主环境下同时运行多个使用相同端口的容器.

由于Docker的网络转发, 使得容器内的服务无法正确的得到自己对外服务时的真实端口甚至是 IP 地址, 对于Sentinel而言就产生了以下问题:

1. Sentinel 实例的自动发现机制无法正常工作. Sentinel实例间的相互发现依赖于 Sentinel实例发出的包含自身IP和端口的声明信息, 但由于端口实际上被重新映射而可能导致通过此声明信息并不能正确的与该实例进行连接.
2. 类似的, Master实例关联的Slave实例信息通常有Master实例的INFO命令给出, 在Master尝试以TCP连接与Slave握手通信时, 端口信息由Slave实例给出, 同样的, 可能并不正确.

由于 Sentinel实例依赖Master实例INFO命令的输出来发现Slave实例, 因此其在这种环境下Sentinel实例得到的Slave 实例信息可能无法使其正确的与Slave实例连接, 从而以Sentinel实例的视角来看当前并没有仍在正常运作的Slave实例, 进而在Master实例挂掉之后无法完成故障迁移. 因此, 除非在部署时将映射的端口与容器内Redis服务使用的端口配置的一致, 否则Sentinel集群无法征程运行.

为防止你一定需要使用Docker的端口映射功能(或其他基于 NAT 的技术), Sentinel提供了一下配置命令来强制Sentinel实例声明的IP和端口:

```shell
sentinel announce-ip <ip>
sentinel announce-port <port>
```

当然, Docker也支持在Host网络环境下运行容器(通过 --net=host 参数), 在这种情景下由于端口没有被重新映射而不会产生上述问题.
