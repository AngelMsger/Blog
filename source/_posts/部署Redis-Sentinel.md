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
Redis Sentinel 为 Redis 提供了高可用方案. 可以在无人为干预的情况下容忍一定程度的错误, 宏观的说, Redis Sentinel 实现了以下功能:
1. 监控: Sentinel 检查 Master/Slave(听说因为此称谓因为带有"奴隶"字样而被起诉, 未来会改名2333) 是否正常工作.
2. 提醒: 当 Redis 实例挂掉的时候, Sentinel 可以通过一定方式通知运维人员.
3. 容错: 当 Master 挂掉的时候, Sentinel 可以通过一系列神奇的操作为集群选举新的 Master, 并将其他 Slave 和连接重新配置到新 Master 上.
4. 服务发现/配置提供: Sentinel 可以充当一个服务发现节点, 向消费者提供可用的 Redis 实例地址.

Sentinel 本身也由多个分布式进程组成, 由此可以带来以下好处:
1. 只有多个 Sentinel 都无法与 Master 通信时才判定其已失效, 降低了误判的风险.
2. Sentinel 本身在少数节点挂掉时仍能正常服务, 提升了容错性

# 起步

## 获取 Sentinel
通常, 通过系统的包管理器安装 Redis 或直接从 Redis 官网下载的预编译二进制包已经集成了 Sentinel.

```shell
# Nothing for Windows User :)

# Using Pacman on ArchLinux
sudo pacman -S redis

# Using Homebrew on MacOS
brew install redis

# Test Installation
redis-sentinel -v
Redis server v=5.0.2 sha=00000000:0 malloc=libc bits=64 build=6fc0f5745dcba2c3
```

当前的 Sentinel 版本为 Sentinel 2, 它使用下文将提到的更为简单且健壮的算法重新实现了最初的版本, 并在自 Redis 2.8 版本后被集成在发行包中, 而自 Redis 2.6 版本开始提供的最初版本目前已被废弃.

## 运行 Sentinel
首先需要创建一个配置文件. Sentinel 依赖此配置文件来记录状态并在重启是恢复, 因此此文件必须可写, 如果不提供一个合法的配置文件路径, Sentinel 会拒绝启动, 此处我们先创建一个空文件用以测试, 稍后我们将讨论 Sentinel 的配置. 你可以通过两种方式启动 Sentinel, 效果相同:

```shell
touch ./sentinel.conf
redis-sentinel ./sentinel.conf
...
^C
redis-server ./sentinel.conf --sentinel
...
```

Sentinel 启动后会监听 26379 端口, 因此此接口不能被占用并应保证接下来能够正常访问.

## 部署 Sentinel 前需要知道的事情
1. 一个高可用的系统至少需要 3 个 Sentinel 实例部署在稳定性相对独立的宿主环境中(原因和其他集群一样).
2. 由于 Redis 复制集的异步性, Sentinel + Redis 组合并不能保证在一次失败期间写入的数据能够完整的保留.
3. Sentinel 模式需要客户端的支持, 目前绝大多数都没什么问题, 但并非全部.
4. 对于使用 Docker 或其他端口转发的环境的用户需要特别注意, 端口重映射会影响 Sentinel 实例发现其他 Sentinel 实例和 Redis 主从实例, 因此 Sentinel 或者说 Redis 与 Docker 协同工作时请务必仔细阅读下文中将提到的相关内容.

## 配置 Sentinel
Redis 的发行包中已经附带了一个注释详尽的自说明的配置文件 sentinel.conf 文件, 此处使我们使用一个简化的配置文件:

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

在配置时对于一个 Redis 复制集仅需指定 Master 节点即可, Slave 节点会被自动发现和配置, 不同的复制集必须各自有唯一的名称. Sentinel 会在配置文件中保留集群状态信息用以在出错后恢复. 配置文件会在 Redis 集群每次重新选举 Master 或发现了新的 Sentinel 实例时被更新.

在上述例子中, Sentinel 监控了两个 Redis 复制集, 每个复制集由一个 Master 节点和不确定个 Slave 实例组成, 并将其中一个复制集命名为 mymaster, 另一个命名为 resque. 对于命令 monitor 的选项配置如下:

```shell
sentinel monitor <master-group-name> <ip> <port> <quorum>
```

也就是配置文件的第一行实际指出了监控一个名为 mymaster 的复制集, 其 Master 节点当前的 IP 为 127.0.0.1, 端口为 6379, 仲裁数为 2. 关于仲裁数这里需要展开说明一下, 这个数字定义了需要多少 Sentinel 节点与 Master 失联才判定为 Master 已失效从而开启一轮故障迁移(为集群选举新的 Master 并将其信息告诉尝试连接的客户端等), 但这个数字必须大于 Sentinel 集群实例的一半, 换言之, 必须是 Sentinel 集群中的绝大多数认同的失败才会引起故障迁移.

## 其他参数
对于上述示例配置文件, 下方几个命令起到了如下作用:

* down-after-milliseconds 指定了 Sentinel 能够接受的各复制集 Master 最长的失联时间, 单位为毫秒, 如果超出这个时间 Sentinel 仍不能连接到 Master, 则 Sentinel 会标记此 Master 已经失效并触发后续行为.
* parallel-syncs 指定了最多有多少个 Slave 节点可以在同一时间从 Master 节点同步数据, 数字越小则同步时间所需越长. 如果你能够接受主从数据在短时间内不同步但不能接受有从节点无法对外服务, 则应当把这个参数设置的尽量小. 尽管从 Master 节点同步数据通常是异步且不阻塞 Slave 节点对外服务的, 但有大量数据需要同步时 Slave 节点仍有可能不得不短暂的暂停服务以完成对数据的加载.

更多配置命令可以参考官方文档的 API 部分. 所有的配置命令除了在配置文件中写入外都支持在 Sentinel 实例运行时通过 SENTINEL SET 命令进行修改.

## 基础使用
下面演示 Sentinel 实例的几个常用操作:

查看集群 Master 实例信息:

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

客户端寻找集群当前的 Master 节点:

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

此外, Sentinel 还支持动态配置集群信息, 调整集群结构, 通过 Pub/Sub 的方式监控集群故障迁移行为等功能.

# 部署演示
下面我们使用几个 ASCII 图来简单的演示 Sentinel 的在几种情形下的部署结构, 首先来解释一下图例. 我们使用方框代表一台物理/虚拟机器:

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

* Master 实例被标记为 M1, M2, M3, ..., Mn.
* Slave 实例被标记为 R1, R2, R3, ..., Rn (R 代表 Replica).
* Sentinel 实例被标记为 S1, S2, S3, ..., Sn.
* 客户端被标记为 C1, C2, C3, ..., Cn.
* 当实例的状态或其在集群中的角色发生变化时, 我们用方括号标识. 如 [M1] 代表由于 Sentinel 的介入, 一个实例的身份变为 Master.

## 基础的三节点集群
对于一个非常简单的集群, 通常至少需要 3 个节点(若为 2, 则任一节点挂掉后都无法实现"绝大多数仍存活"这一基本条件, 集群无法继续对外服务, 因此实际上与 1 个节点一样不具备容错性). 我们接下来演示在 3 台机器上部署集群, 每台机器上各运行一个 Sentinel 实例和一个普通 Redis 实例.

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

当 M1 挂掉的时候, S2 和 S3 都将认同 M1 的连接已丢失这一事实, 从而触发一次故障前一, 接下来客户端的连接将被导向原从节点中的一个. 由于 Redis 复制集的异步性, 在故障迁移过程中都有可能会丢失少量的已写入数据. 如下图所示, 由于客户端 C1 在未了解到集群状态变化时尝试将数据写入已丢失的分区内的 Redis 实例而导致其数据丢失:

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

在这种情况下由于网络原因使得原 Master 节点被孤立, 原 Slave 节点升级为 Master 节点. 一旦 M1 从故障中恢复, 其将降级为 Slave 节点并尝试与新的 Master 节点同步数据, 这将导致故障期间来自客户端 C1 的写入永久丢失. 这一现象可以通过配置 Redis 实例在检测到已写入数据无法同步到指定数量的 Slave 节点时拒绝写入请求的方式来缓解:

min-slaves-to-write 1
min-slaves-max-lag 10

以上配置(详情可以查看自说明配置文件 redis.conf)制定了 Redis 实例作为 Master 角色时, 如果不能讲写入结果同步到至少一个 Slave 实例上时将拒绝写入请求, 由于数据同步本身是异步的, 因此需要另一个参数指出超出多长时间没有收到来自 Slave 实例的确认时判定为网络故障.

## 将 Sentinel 部署到客户端
当我们仅有两个主机分别部署了 Master 实例和 Slave 实例时, 上述方法不适用, 则此时我们可以将 Sentinel 实例部署到客户端服务器上(广义的客户端啦, 比如对外服务的 Web Server, 不是真正用户手里的那种).

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

在这种配置下, Sentinel 实例的视角与客户端相同, 如果 Master 实例对于绝大多数客户端是可见的, 那么 Sentinel 同样可见, 此时集群是正常服务的. 如果 M1 和 S1 服务挂了, 故障迁移流程将正常被触发, 不过显而易见, 在各种可能的错误下, 不同的网络分区导致的结果也对应着很多种结果, 如果所有客户端与所有 Redis 实例服务端间的网络断开了, 网络将无法正常对外服务.

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

这种结构在客户端/服务端都部署了 Sentinel 实例, 可以看出在 M1 实例意外挂掉后其余节点仍能正常的完成一次故障迁移. 你可能觉得节点数量还可以再减少, 比如我们只有一个客户端服务器, 并且也能完成故障迁移程序, 毕竟我们仍有 3 个节点. 这当然是可以的, 只不过即使是客户端大多时候我们也会作高可用处理, 1 个节点当然不太好啦.

# Sentinel 在 Docker 或 NAT 下可能的问题
Docker 使用一种名为端口映射的技术, 使得服务实际对外暴露的端口与服务本身所认为开启的端口可能并不相同, 此项技术允许在同一宿主环境下同时运行多个使用相同端口的容器.

由于 Docker 的网络转发, 使得容器内的服务无法正确的得到自己对外服务时的真实端口甚至是 IP 地址, 对于 Sentinel 而言就产生了以下问题:

1. Sentinel 实例的自动发现机制无法正常工作. Sentinel 实例间的相互发现依赖于 Sentinel 实例发出的包含自身 IP 和端口的声明信息, 但由于端口实际上被重新映射而可能导致通过此声明信息并不能正确的与该实例进行连接.
2. 类似的, Master 实例关联的 Slave 实例信息通常有 Master 实例的 INFO 命令给出, 在 Master 尝试以 TCP 连接与 Slave 握手通信时, 端口信息由 Slave 实例给出, 同样的, 可能并不正确.

由于 Sentinel 实例依赖 Master 实例 INFO 命令的输出来发现 Slave 实例, 因此其在这种环境下 Sentinel 实例得到的 Slave 实例信息可能无法使其正确的与 Slave 实例连接, 从而以 Sentinel 实例的视角来看当前并没有仍在正常运作的 Slave 实例, 进而在 Master 实例挂掉之后无法完成故障迁移. 因此, 除非在部署时将映射的端口与容器内 Redis 服务使用的端口配置的一致, 否则 Sentinel 集群无法征程运行.

为防止你一定需要使用 Docker 的端口映射功能(或其他基于 NAT 的技术), Sentinel 提供了一下配置命令来强制 Sentinel 实例声明的 IP 和端口:

```shell
sentinel announce-ip <ip>
sentinel announce-port <port>
```

当然, Docker 也支持在 Host 网络环境下运行容器(通过 --net=host 参数), 在这种情景下由于端口没有被重新映射而不会产生上述问题.

