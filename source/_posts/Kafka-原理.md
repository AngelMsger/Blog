---
title: Kafka 原理
tags:
typora-root-url: ../../source/
---

[Kafka](https://kafka.apache.org/) 是一款流行的消息队列中间件, 以至于我在担任面试官期间遇见的大多数在简历上写熟悉消息队列的同学实际项目中都在使用 Kafka.

与传统消息队列不同, Kafka 的设计以服务于大数据时代中的**事件驱动应用**为导向, 以**日志**或消息为业务系统的核心. 举个例子, 用户通过**上游**服务创建表单提交数据, **多个下游**服务会消费这条日志, 执行如业务埋点, 审计, 流处理或搜索引擎记录同步等.

在生产环境中, 上述日志是**海量**的, 传统消息队列在**吞吐性能**, **消息堆积**和**弹性扩缩容能力**上表现不尽人意, 而 Kafka 的架构设计改善了这些问题, 结合良好的**上下游及社区生态**, 共同促成了 Kafka 今天的成功.

本文尝试解析 Kafka 背后的设计与实现, 大纲和图片资源主要内容来自 Kafka 云服务商 [Confluent](https://www.confluent.io/) 员工分享的[课程](https://developer.confluent.io/courses/architecture/), 但本文不是单纯的搬运和翻译, 我在学习过程中查阅了官方文档, 原始设计稿和博客, 添加了一些功能在实现层的细节介绍和个人理解, 因此会更深入. 原课程质量不错 , 感兴趣的同学可以移步观看.

## 总览

和传统消息队列一样, 在 Kafka 的概念中, 消息生产者称为 **Producer**, 消息消费者称为 **Consumer**, 存储消息的中间件称为 **Broker**. Kafka 的整体设计如下:

![Kafka_Internals_004](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_004.png)

最核心的是位于中间的 Broker, 外层提供了生产端的 [Producer API](https://kafka.apache.org/documentation/#producerapi) 和消费端的 [Consumer API](https://kafka.apache.org/documentation/#consumerapi). 基于这些能力, Kafka 封装了更高级的 [Kafka Connect](https://kafka.apache.org/documentation.html#connect) 和 [Kafka Streams](https://kafka.apache.org/documentation/streams/), 前者用于**对接上下游**, 后者用于**流计算**.

在 Connect API 之上, Kafka 社区构建了[良好的 Connector 生态](https://docs.confluent.io/platform/current/connect/kafka_connectors.html), 结合此前提到的高吞吐, 可堆积和易伸缩等特点, 使 Kafka 常常应用于 [CDC](https://www.confluent.io/learn/change-data-capture/) 类场景.

在 Streams API 之上, 一些开源项目提供了更高级的封装或产品, 如 [ksqlDB](https://ksqldb.io/).

### Record

在 Kafka 中, 日志或事件的结构称为 **Record**. 一个 Record 包含时间戳, Key, Value 和可选的 Headers. 其中 Key 和 Value 是 Byte Array, 没有特别的编码限制, 但支持指定 Schema, 如 JSON Schema 或 Protobuf, 当指定 Schema 时需要先注册元数据, 实际传输时会通过 Magic Byte 进行标记.

![inline-pic-schema](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Producers_3.jpg)

### Topic

上游生产的 Record 进入 Broker 后以 **Topic** 形式组织. Topic 是一个逻辑结构, 与传统消息队列中的 Queue 类似, 只能**顺序追加**, **不可修改**. 但与 Queue 不同, Topic 中的 Record 在消费后不会立即删除, 而是通过特定规则如过期时间进行淘汰, 因此如果业务需要, Record 支持被多次消费, 这为上层业务带来了额外的**容错性**.

![inline-pic-topic](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_007.png)

### Partition

为支持存储和计算的**横向扩展**, Kafka 引入 **Partition** 概念对 Topic 进行分区, 类似数据库分片. Topic 由一个或多个 Partition 组成, 多个 Partition 可以分布在相同或不同的物理节点上. Record 通过特定规则进入特定 Partition, 类似数据库分片路由.

Partition 同时还是 Kafka 的**并行控制**单元, 生产者通过 Partition 实现 Topic 的并发写入, 不同消费者从不同 Partition 消费从而实现负载均衡. 在 Kafka 中, 为了保证**消费顺序**, 每个 Partition 只被一个消费者消费, 因此 Partition 和消费者的伸缩通常需要综合考虑.

在 Partition 中, 每个 Record 会被分配一个唯一标识符, 称为**偏移量**(Offset), 它是一个单调递增值, 有很多应用场景, 其中之一是供消费者标识消费位置.

上述过程会在后文详细介绍.

![inline-pic-partition-2](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_009.png)

## Broker

如前所述, Broker 是 Kafka 集群的核心, 其功能可以分为**控制面**和**数据面**. 控制面负责管理集群元数据, 数据面负责处理实际业务数据.

### 数据面

我们首先介绍**数据面**.

客户端请求可以分为**生产者请求**和**消费者请求**, 前者向 Topic 中写入 Record, 后者从 Topic 中拉取 Record.

![inside-the-apache-kafka-broker](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_016.png)

#### 生产者请求

##### 分片规则

生产者发送 Record 时, 会根据**可配置的 Partitioner** 来决定写入的 Partition. 由于分片路由行为由生产者控制, 因此除了下述内置规则, 生产者也可以注册**自定义规则**.

###### 默认

如果 Record 包含 Key, **默认 Partitioner** 会根据 **Key 的哈希值**决定 Partition, 否则以 Round Robin 方式选择一个 Partition. 这种分片规则保证只要 Partition 的数量不变, Key 存在且相同的 Record 一定会**按序**写入**相同的 Partition**.

![img](/images/Kafka-%E5%8E%9F%E7%90%86/guide-kafka-partition-img1.png)

###### Round Robin

**Round Robin Partitioner** 会将 Record **循环**分配给各 Partition. 由于这种分片规则与 Record 的 Key 无关, 因此**不能维持 Key 相同消息的有序性**, 但能**避免数据倾斜**.

![img](/images/Kafka-%E5%8E%9F%E7%90%86/guide-kafka-partition-img2.png)

###### Uniform Sticky

**Uniform Sticky Partitioner** 是默认 Partitioner 的改进方案, 这涉及到一部分后文才会介绍的设计, 如果你看不懂以下内容, 可以先跳过本节.

这种分片规则的出发点是默认 Partitioner 对于不包含 Key 的 Record 退化为 Round Robin 策略的设计, 与即将介绍的批量发送的设计结合后, 可能导致 Record Batch 在尚未积累足够的 Record 时就达到超时阈值而被发送, 从而无法最大化生产端吞吐. 其改进方式是在上述背景下, 选择一个 Partition 作为 Sticky Partition, 直到 Record Batch 满足阈值被发送, 再以 Round Robin 的方式选择下一个 Partition 作为 Sticky Partition, 以此类推.

![img](/images/Kafka-%E5%8E%9F%E7%90%86/guide-kafka-partition-img3.png)

##### 批量发送

如果每个 Record 被生产后立刻向 Broker 发送, 那么数量中多的小 I/O 带来的 **Overhead** 会降低整体的吞吐. 因此 Kafka 生产者实际会通过客户端封装将 Record 在本地进行 **Buffer** 继而实现**批量发送**, Buffer 后的 Record 称为 **Record Batch**.

除了提升 I/O 效率, 批量发送的行为还能**优化压缩比**. 试想如果向某个 Topic 发送的 Record 内容是通过 JSON 序列化后的业务通知, 那么消息间必然存在大量重复的租户 ID, 模板 Key 等, 批量压缩必然比逐条压缩更具效率.

![records-accumulated-into-record-batches](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_018.png)

Kafka 的生产者客户端会控制批量发送时机, 如 Record Batch 到达了**指定大小**, 或已经构造了**指定时长**, 这些阈值可通过配置调整.

![record-batches-drained-into-produce-requests](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_019.png)

##### 网络线程

由生产者发送的包含 Record Batch 的请求到达 Broker 后首先进入 **Socket Receive Buffer**, 随后网络线程池中的**网络线程**会读取该 Buffer 中的数据并构造 **Produce Request Object** 加入**请求队列**.

![network-thread-adds-request-to-queue](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_020.png)

##### I/O 线程

随后, I/O 线程池中的 **I/O 线程**会从请求队列中获取请求, 进行基础校验如 CRC 并将其写入 Partition 的物理数据结构 **Commit Log**. Commit Log 的刷盘是**异步**的.

![io-thread-verifies-record-batch-and-stores](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_021.png)

##### 物理存储

Commit Log 在磁盘上会拆分为 **Segment** 进行存储, 每个 Segment 包含一个 **`.log` 文件**和一个 **`.index` 文件**, 前者包含日志数据, 后者包含索引结构, 如 Partition 中 Record 的逻辑偏移量到 `.index` 文件中的物理偏移量.

![kafka-physical-storage](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_022.png)

##### 数据可靠性

应用程序对文件系统的写操作并不是每次都落盘, 而是会被操作系统进行**缓冲**以提升 I/O 性能. 根据操作系统和文件系统的策略, 缓冲的数据会被**异步刷盘**. 期间如果操作系统崩溃, 这些数据就可能丢失. 因此内核也允许应用程序通过调用 [fsync](https://man7.org/linux/man-pages/man2/fsync.2.html) 自主决定何时刷盘. 关系型数据库通常会通过 [WAL](https://www.postgresql.org/docs/current/wal-intro.html) 保证数据的持久性, WAL 的写入通常伴随着 `fsync` 被调用.

为了提升写入吞吐, Kafka 并不会为每个 Record 或 Record Batch 执行 `fsync`, 因此数据在短时间内会留存在 **Page Cache** 中. Kafka 依赖**副本集**提供**数据可靠性**(Durability), Broker 在写入本地缓冲后, 不会立即向生产者确认数据提交, 而是等待所有有效副本也都将该 Record 写入本地缓冲并通知 Leader.

为了避免 I/O 线程等待副本复制过程, Kafka 做了类 Reactor 模式的优化(类似 Node.js 的 Event Loop 执行线程不会等待 Pending 状态的 Promise), 请求会暂存在名为 **Purgatory** 的结构中, 随 I/O 现成就将继续处理其他请求, 直到该请求的副本复制过程完成, 再将其从 Purgatory 中取出来加入**响应队列**.

![purgatory-holds-requests-being-replicated](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_024.png)

##### 返回确认

网络线程从响应队列中拿到响应后会发送到 **Socket Send Buffer**. 如果客户端还有未被确认的响应, 那么网络线程不会将其下一个请求加入请求队列, 以此来保证消息在**生产端的有序性**.

![response-added-to-socket-send-buffer](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_025.png)

#### 消费者请求

##### 响应过程

与 RabbitMQ 等传统消息队列不同, Kafka 的消费者需要主动从 Topic 中**拉取**消息. 消费者的拉取请求需要包含 **Topic**, **Partition** 和**偏移量**. Partition 的选择会在后文委派策略章节单独介绍.

与生产者请求的处理过程类似, 消费者请求到达 Broker 后:

- 进入 **Socket Receive Buffer**.
- 被**网络线程**读取并加入**请求队列**.
- 被 **I/O 线程**读取并定位到具体 **Topic** 的 **Partition** 的 **Segment**.
- 根据**逻辑偏移量**, 通过 `.index` 文件的内容转换为 `.log` 文件的**物理偏移量**及**范围**.
- 读取 **Record** 的内容, 组装**响应对象**并返回.

同样的, 为了避免小 I/O 带来的 **Overhead**, Kafka 在消费者请求响应过程中也引入了**缓冲**逻辑, 缓冲中暂未返回的响应对象也存储在 **Purgatory** 结构中.

![fetch-requests](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_026.png)

##### 性能

高吞吐是 Kafka 相比传统消息队列的特点之一, 前文介绍了相关基础概念, 接下来我们深入讨论一下背后的原因. 前文已经提过的 **Partition 并行**, **缓冲压缩优化**这里不再重复.

###### Page Cache 缓存

"磁盘访问慢"几乎是每个开发者都存在的刻板印象, 但实际上磁盘访问的速度与其**访问方式**有很大关系, 有时比想象的快很多, 有时又比想象的慢很多. 比如 7200 转的 SATA RAID-5 阵列顺序写入可以达到 600M/s 而随机写入却只有 100k/s, 有 6000 倍的差距. 而根据 [ACM Queue 的报告](https://queue.acm.org/detail.cfm?id=1563874), 在结合现代操作系统预读机制的前提下, 磁盘**顺序访问**在极端场景下甚至可以快过内存**随机访问**.

操作系统为了弥合内存和磁盘的访问速度差异, 通常会将空闲内存用作缓存, 所有对磁盘的读写也都将经过这些缓存. 因此如果在应用内存中再次维护缓存, 相当于内存中就维护了**两份数据**. 而且应用还需要自行处理缓存与文件系统的**数据一致性**, 提升了实现的复杂度. 一旦程序崩溃重启, 这些缓存也就随之失效, 导致应用重启后需要经历**冷启动**过程, 构建 10GB 的内存缓存有时需要 10 分钟时间. 最后, 由于 Kafka 是通过 Java 开发的, 在 JVM 平台做数据处理有两个绕不开的问题, 一是其内存模型带来的 **Overhead**, 如 Box 后的基础类型的双倍内存空间占用, 二是 **GC** 在堆内存空间较大时的性能问题.

利用操作系统的 Page Cache 实现缓存避免了上述问题. 由于大幅提升了内存的利用率, Kafka 能在 32 GB 内存的机器上利用大约 28 ~ 30 GB 的内存空间作为缓存, 并且被缓存的数据不会随着 Broker 进程的重启而失效. 在 Kafka 的设计预期中, Topic 中的 Record 可以被多个消费者多次消费, 在这种情况下, Page Cache 中的数据也将被多次利用.

###### Commit Log 结构

与传统消息队列使用类 **B 树**结构组织消息队列元数据和数据不同, 前文介绍 Kafka 使用的 **Commit Log** 实际上是类似于 **LSM 树**的一种结构. 大家入职时都被要求阅读过 《[DDIA](https://dataintensive.net/)》, 所以 LSM 树的原理就不再展开介绍了, 只是在 Commit Log 中, 逻辑偏移量可以视为 Key, 它单调递增且不会重复, 因此 `.log` 文件的内容是天然的 **SSTable**, `.index` 文件中则保存了逻辑偏移量到物理偏移量的**稀疏索引**. 根据消息队列的性质, Segment 间通常不需要进行合并.

Segment 文件名是该文件首个 Record 的**逻辑偏移量**, 当消费者请求到来时, Kafka 首先通过请求中的 Topic 和 Partition 找到对应的 Commit Log 目录, 然后通过对文件名的 BinarySearch 定位到具体的 Segment 文件, 最后通过 SSTable 的查找方案找到 Record. 结合前文, 过程通过 Page Cache 缓存.

Commit Log 的顺序读写特性也是 Kafka 吞吐性能高的主要原因之一.

![kafka_partition_segments](/images/Kafka-%E5%8E%9F%E7%90%86/Adv_Kafka_Topic_Internals_2.jpg)

###### 零拷贝

我们知道从磁盘获取数据并发送到网络的传统方式分为以下步骤:

1. 操作系统将文件内容从磁盘读取到内核空间的 Page Cache.
2. 应用程序将数据从内核空间读取到用户空间.
3. 应用程序将数据写出到内核空间的 Socket 缓冲.
4. 操作系统将数据从 Socket 缓冲写出到 NIC 缓冲并发送.

如果应用程序无需解析和修改这些数据, 上述过程进行了 4 次数据拷贝和 2 次系统调用, 显然是很低效的. 内核提供了 [sendfile](https://man7.org/linux/man-pages/man2/sendfile.2.html) 来避免上述问题, 它能使数据直接从 Page Cache 发送到 NIC 缓冲, 这种优化也称为**零拷贝**. 更多细节大家可以通过[这篇文章](https://developer.ibm.com/articles/j-zerocopy/)了解.

零拷贝技术应用的前提是在生产者, Broker 和消费者间共享的标准化**二进制格式设计**, 从而使传输和存储过程中无需修改数据本身, Kafka 设计了这种格式, 我们在前文中也有提及. 同样正如前文所述, Topic 中的 Record 可以被多个消费者多次消费, 在这种情况下, 从磁盘到 Page Cache 的拷贝过程也只需要一次就可以多次响应消费请求.

至此我们可以总结支撑 Kafka 高吞吐性能背后的设计:

- 通过 Partition 实现并行.
- 通过 Commit Log 结构实现磁盘顺序读写.
- 充分利用操作系统 Page Cache, 避免 JVM 内存模型带来的 Overhead 和 GC 问题.
- 应用了零拷贝技术.
- 批处理和数据压缩优化.

#### 副本

**副本**(Replication)是很多数据应用提供**可用性**(Availability)的方案, 如 MongoDB 副本集. 在 Kafka 中副本还承担提供数据**可靠性**(Durability)的责任, 在前文相关章节也有提及.

Kafka 支持在 Topic 粒度设置副本规则, 设置后该 Topic 的所有 Partition 都将遵循该规则. 副本数量在 Kafka 中也称为**副本因子**(Replication Factor). 副本因子为 N 的 Topic 能够容忍 N - 1 个节点失效, 这与其他追求一致性而无法容忍半数以上节点失效的系统设计不同. 熟悉分布式理论的同学立刻会问, 这种设计怎么在网络分区场景下保证集群的数据一致性呢, 后文会给出答案.![kafka-data-replication](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_029.png)

##### 数据复制

###### ISR

Partition 的副本集创建后, 其中一个副本会被选择为 **Leader**, 其余副本则为 **Follower** , 选举过程后文介绍.

生产者根据**集群元数据**获得 Partition 的 Leader 地址并在生产消息时进行**本地路由**. 生产者向 Leader 写数据, Follower 从 Leader 消费数据, 在这一场景中 Follower 的行为与消费者类似. 当然, Follower 也支持从其他 Follower 消费数据, 实现形如串联的拓扑结构.

Follower 从 Leader 消费数据时, 受网络与节点性能影响可能产生延迟, 延迟在一定阈值内的 Follower 与 Leader 一起组成了 Kafka 中的列表结构 **ISR**(**I**n-**S**ync **R**eplica). ISR 动态维护在 Kafka 集群元数据中, 元数据的存储在控制面中介绍.

![leader-follower-isr-list](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_030.png)

###### Epoch

每个 Leader 都会关联一个名为 **Epoch** 的数字变量, 用于**跟踪**由该节点担任 Partition Leader 期间写入的数据. 当集群选举出新 Leader 时, Epoch 也会**自增**. Epoch 的主要作用是达成数据一致, 在后文选举过程中介绍.

![leader-epoch](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_031.png)

###### 复制

当 Leader 将 Record 写入本地后, Follower 将通过与前文介绍的消费请求类似的 **FetchRequest** 复制该数据. FetchRequest 包含了 Follower 请求的**偏移量**.

![follower-fetch-request](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_032.png)

Leader 会向 FetchRequest 响应 **FetchResponse**. FetchResponse 包含了 FetchRequest 声明偏移量之后的 **Record** 及其**偏移量**和 **Epoch**. 随后 Follower 将这些信息复制到本地.

![follower-fetch-response](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_033.png)

Follower 发送的 FetchRequest 携带的偏移量, 除了用于向 Leader 请求该**偏移量后**的 Record, 同时也向 Leader 表明该**偏移量前**的数据已被该 Follower 成功复制. Leader 通过这种方式**跟踪**每个 Follower 的**复制进度**.

由于 ISR 中仅维护复制延迟在一定阈值内的节点, 因此当 Follower 由于宕机, 网络或性能问题迟迟无法完成同步时, 它将离开 ISR, 直至其恢复.

当 ISR 现存的所有 Follower 都确认某个偏移量之前的 Record 已被成功复制, 那么这些 Record 就被视为**已提交**(Commited). 已提交的 Record 对消费者可见.

![committing-partition-offsets](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_034.png)

###### Watermark

在上述行为中, 各副本是如何对 "哪些 Record 被 ISR 中的所有副本确认" 达成共识的呢? 答案是 **Watermark** 机制.

前文已经介绍过, Leader 可以根据 FetchRequest 中的偏移量跟踪每个 Follower 的复制进度, 因此 Leader 有能力维护已提交偏移量的边界, 然后将该值通过 FetchResponse 传递至 Follower. 这个值也称作 Watermark.

由于副本复制是异步的, 因此通常 Follower 的 Watermark 与复制过程一样, 会与 Leader 存在一定延迟.

![advancing-the-follower-high-watermark](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_035.png)

##### Leader 失效

当当前 Leader 失效或出于某些原因需要更换 Leader 时, 集群需要选举新的 Leader. **选举过程**在后文控制面部分介绍, 这里我们主要介绍 Leader 失效后数据面如何保证**消息不丢失**.

根据前文对 ISR 和 Watermark 机制的介绍, ISR 中所有副本都提交了 Watermark 前的 Record, Kafka 从 **ISR** 中选举一个副本成为新的 Leader, 同时增加 **Epoch** 的值. Leader 的变化经由**控制面**广播到其他副本和生产者, 此后新 Leader 开始处理生产者的生产请求.

![handling-leader-failure](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_036.png)

###### Watermark 滞后

如图所示, **新 Leader 的 Watermark 可能低于旧 Leader**, 这是因为前文提到 Follower 通过 FetchResponse 中的属性同步 Watermark 更新, 而 FetchResponse 的返回是异步的. 当出现这种情况时, 如果消费者向新 Leader 请求**当前 Watermark** 和**此前 Watermark** 中间偏移量的 Record, Broker 将会抛出一个**允许重试**的**偏移量不存在**(实际为不可见)错误. 消费者捕获该错误后会**本地重试**, 直到新 Leader 修正 Watermark.

![temporary-decreased-high-watermark](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_037.png)

###### 未提交数据不一致

在上述情况中, 由于新 Leader 还有未拿到的 FetchResponse, 因此其相较其他 Follower 可能缺失一些**未提交的数据**, 如果不解决这个问题, 副本复制的过程就无法继续.

![partition-replica-reconciliation](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_038.png)

###### 副本调和

Kafka 中解决上述问题的过程称为**副本调和**(Replica Reconciliation).

当存在**不一致未提交数据**的 Follower 通过发送 FetchRequest 从新 Leader 复制数据时, 后者会从请求中获取 **Epoch** 和**偏移量**并与本地数据比对, 从而发现**请求非法**. 此时新 Leader 会在 FetchResponse 中告知该 Follower 其请求的 Epoch 应在何处**截断**.

![partition-replica-reconciliation](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_039.png)

Follower 收到响应后会**清理**这些未提交并判定为失败的 Record. 这些 Record 的 生产者此后会因为**未得到提交成功的响应**而自行处理失败情况.

![follower-truncates-log-to-match-leader-log](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_040.png)

**清理后** Follower 会携带**被修正的偏移量**重新向新 Leader 发起 FetchRequest. 在本例中, 该请求对新 Leader 而言同时意味着偏移量 3 之前的 Record **被 ISR 中所有 Follower 确认**, 因此新 Leader **滞后的 Watermark 也将被修正**.

![subsequent-fetch-with-updated-offset-and-epoch](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_041.png)

Leader 随后将**新 Epoch 期间**写入的 Record 通过异步 FetchResponse 返回至 Follower.

![follower-102-reconciled](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_042.png)

当 Follower 发起**下一轮 FetchRequest** 时, 上述 Record 的写入也将被确认, 继而新 Leader 可以继续**更新 Watermark**. 这时 Follower 和新 Leader 的调和过程就结束了, 回归常规的副本复制过程. 但此时由于老 Leader 仍未恢复, ISR 中并不包含预期内的所有副本.

![follower-102-acknowledges-new-records](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_043.png)

假设某个时刻**老 Leader 恢复上线**, 那么它将首先通过控制面提供的元数据**找到新 Leader** 并尝试从新 Leader **同步数据**, 过程中也可能会经历上述**副本调和**过程. 最终它将恢复数据同步并**回归 ISR**.

![follower-101-rejoins-the-cluster](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_044.png)

##### Follower 失效

除了 Leader 失效触发重新选举并更换 Leader, 集群一些 Follower **崩溃**或**复制进度滞后**的问题.

如前所述, Leader 节点通过来自 Follower 的 FetchRequest **跟踪**每个 Follower 的复制进度. 如果指定 Follower 的滞后情况超出配置阈值, Leader 会将其从 ISR 中移除, 从而避免该 Follower **持续阻塞 Watermark 的更新**. 当该 Follower 恢复上线并将复制进度追赶至阈值以内, 它将重新加入 ISR.

我们都熟悉著名的 [CAP 理论](https://en.wikipedia.org/wiki/CAP_theorem), Kafka 的 ISR 显然是倾向 **AP** 的架构设计, 但 Kafka 也支持通过参数 `min.insync.replicas` 和 `acks` 配置[ISR 中最少节点数量](https://kafka.apache.org/documentation/#topicconfigs_min.insync.replicas)和[最少需要几个副本确认写入后返回](https://kafka.apache.org/documentation/#design_ha), 从而在**一致性**与**可用性**间取得平衡.

![handling-failed-or-slow-followers](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_045.png)

##### Leader 均衡

根据上文描述, Leader 所在的 Broker 相比 Follower 所在的 Broker 多承担了一些工作, 为了避免**单点性能瓶颈**, 不同 Partition 的 Leader 应尽量**分散**在不同 Broker 上.

Kafka 利用 Partition 创建时的 Broker **均衡策略**, 并将 Partition 的首个副本指定为 Leader, 从而解决了上述问题, 此时该副本也称为 Partition 的**首选副本**(Preferred Replica).

Leader **重新选举**可能会**打破**这种初始均衡, 因此 Kafka 会**定期检查**集群内各 Partition 的 Leader **分布**, 如果不均衡的情况超出了可配置的**阈值**, Kafka 会进行 Leader 的**重新均衡**, 使一些破坏均衡的 Partition Leader **回到**首选副本上.

![partition-leader-balancing](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_046.png)

### 控制面

接下来介绍**控制面**, 并补充我们在前文中跳过的元数据管理和集群选举等内容.

![kafka-manages-data-and-metadata-separately-2](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_048.png)

#### ZooKeeper 模式

历史上 Kafka 通过外置的 [ZooKeeper](https://zookeeper.apache.org/) 管理集群元数据. 集群中的一个 Broker 被指定为 **Controller**, 负责与 ZooKeeper 及其他 Broker 通信. 这种方案正在逐步废弃, 因此这里不做详细介绍, 感兴趣的同学可以自行学习.

![zookeeper-mode-legacy](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_049.png)

#### KRaft 模式

在 2022 年 10 月 Kafka 发布 3.3.1 版本之后, 将名为 **KRaft** 的新**元数据管理**方案标记为生产环境可用. KRaft 如其名, 是 Kafka 中的 [Raft 协议](https://raft.github.io/)实现. Raft 是一种**分布式场景**下的**共识协议**, 与 ZooKeeper 使用的 [ZAB](https://en.wikipedia.org/wiki/Atomic_broadcast) 协议类似, 这类协议可以帮助分布式环境中的集群节点达成共识, 从而对外保证**数据一致性**. 这里不展开介绍原始 Raft 协议的具体内容, 感兴趣的同学可以点击前面的链接学习, 但会在 Leader 选举章节简单介绍 Kafka 的实现.

当 Kafka 使用 KRaft 模式时, 它不再依赖外部的 ZooKeeper 服务, 而是在集群中选择某些 Broker 指定为 **Controller**, 并提供与此前 ZooKeeper 相似的共识能力. 在这种模式下, Kafka 集群的元数据通过 Kafka **内部 Topic** 直接存储和管理.

![kraft-mode-nascent](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_050.png)

##### 对比

KRaft 模式相比 ZooKeeper 模式的主要优势如下:

- **运维简化**: 只需部署 Kafka, 不再依赖 ZooKeeper.
- **横向扩展能力提升**: Kafka 集群能支持的 Partition 数量是衡量其横向扩展能力的重要指标. 此前这个值受 ZooKeeper 与 Controller 之间传递元数据的限制只能到十万量级, 而 KRaft 模式不需要这种传递, 因此可以提升到百万量级.
- **元数据传播提效**: 元数据通过 Kafka 的 Topic 管理, 并利用 Topic 的生产消费传播, 集成性更好的同时也提升了一些底层实现的性能.

![kraft-mode-advantages](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_051.png)

##### 集群角色

在 KRaft 模式的 Kafka 集群中, 对不同集群规模, 既可以将集群中的节点划分为 **Controller** 和常规 **Broker**, 也可以让一些节点**兼职**两种角色. 节点的角色通过 `processes.roles` 配置.

![kraft-cluster-mode-roles](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_052.png)

每个节点都通过 `controller.quorum.voters` 配置存储了**所有 Controller** 的地址, 使这些节点可以和所有 Controller 通信. Controller 中的一个被指定为 **Active Controller**, 与 Leader 类似, 用与处理元数据变化.

以 Topic 维护元数据意味着 Controller 中元数据的物理存储是**日志式**的, 但每个 Controller 也在内存中维护最新的**元数据视图**. 因此 Controller 节点中的任何一个都可以在需要时**立即接棒**, 成为新的 Active Controller, 这比 ZooKeeper 模式的实现高效很多.

![kraft-mode-controller](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_053.png)

##### 集群元数据

**集群元数据**是控制面的核心, 保存着 Kafka 集群所有资源的状态. KRaft 模式下的 Kafka 集群元数据保存在名为 `__cluster_metadata` 的**内部 Topic** 中.

前面介绍过 Record 的结构, 如果在 Topic 中对相同 Key 总是后来 Record 的 Value **覆盖**生效, 那么 Topic 就可以视为支持**增量变更**的**键值存储**. Broker 可以生产 Record 以更新某项元数据, 也可以消费 Record 监听元数据变化.

这个 Topic 只有一个 **Partition**, 前文提到的 **Active Controller** 实际上就是它的 **Leader**, **Controller** 是它的 **Follower**, 常规 **Broker** 是它的类消费者, 称为 **Observer**. 所以准确地说, 并非 Active Controller 向其他 Controller 或 Broker 推送元数据变化, 而是后者通过 FetchRequest 主动拉取.

![kraft-cluster-metadata](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_054.png)

在上述设计下, 控制面节点的**高可用**实现与此前介绍的**数据面副本复制**类似, 包括**偏移量**, **Epoch** 和**副本调和**等设计, 但与数据面通过 ISR 选择副本集新 Leader 不同, 控制面遵循 **Quorum 规则**选举新 Leader, 我们在后文介绍. 此外, 对集群元数据 Topic 的写入会**立即刷盘**, 以提供更高级别的数据可靠性.

![kraft-metadata-replication](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_055.png)

##### Leader 选举

集群初始化, 宕机或预期内的节点重启如滚动更新时集群需要**选举新的 Leader**. 选举过程与 Raft 协议基本一致, 仅在描述和实现上有一些差异, 比如此前的 Epoch 就是 Raft 协议中的 Term, 我们来简单介绍这一过程.

最早识别到集群需要发起**选举流程**的 Controller 将作为候选人向其他 Controller 发送 **VoteRequest**. VoteRequest 包含候选人当前的集群元数据 Topic **偏移量**和**该偏移量关联的 Epoch**, 同时自增 Epoch 作为**候选 Epoch**. 发起 VoteRequest 的 Controller **投票给自己**.

![leader-election-step-1-vote-request](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_056.png)

Follower 收到 VoteRequest 后, 首先检查是否见过**更大的 Epoch**, 或**已为该 Epoch 投票**给其他候选人, 其次检查 请求中包含的偏移量是否**小于本地偏移量**, 符合任一条件就拒绝该请求, 否则接受该请求, 并返回投票支持该候选人成为新 Leader, 拒绝或接受通过 **VoteResponse** 传递. 收到**超过半数** Controller 投票的候选人可以成为新 Leader.

![leader-election-step-2-vote-response](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_057.png)

候选人满足成为新 Leader 的条件后, 需要通过 **BeginQuorumEpoch 请求**通知其他 Controller 自己**当选为新 Leader**, 结束本轮选举. 后续如果**老 Leader 重新上线**, 他将由于 Epoch 较小而**降级**, 跟随新 Leader 并同步数据.

![leader-election-step-3-completion](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_058.png)

与此前在数据面章节中提到的 Leader 失效带来的问题类似, 控制面完成选举之后也需要进行**副本调和**, 算法设计是一致的.

![metadata-replica-reconciliation](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_059.png)

##### 集群元数据快照

集群元数据 Topic 中的 Record 不能像常规 Topic 一样配置简单的**过期**规则, 也不应随着集群的运行**无限增长**. Kafka 通过**定期快照**来释放并清理历史 Record, 类似 Postgres 的 [Vocuum](https://www.postgresql.org/docs/current/routine-vacuuming.html) 或 RocksDB 的 [Compaction](https://github.com/facebook/rocksdb/wiki/Compaction).

在前文集群角色章节我们提到过 Controller 会在内存中维护 **集群元数据视图**, 在这份视图中每个 Key 仅维护了最新的 Value. Controller 会**定期**将该视图以**快照**形式备份到**磁盘**, 并以快照创建时**元数据 Topic** 的**偏移量**和 **Epoch** 为标识. 快照落盘后, 其关联偏移量前的 Record 就可以被**丢弃**. Controller 可以通过该快照与其后的 Record **聚合**出最新的**完整视图**.

![kraft-cluster-metadata-snapshot](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_060.png)

快照的两个典型使用场景是已有 Broker 的**故障恢复**和**新 Broker** 的上线.

当已有 Broker **重启**时, 它首先从本地**加载最近的快照**并加入本地**集群元数据 Topic**, 随后尝试从 **Active Controller** 复制**该快照最新偏移量**之后的 Record, 如果这个偏移量早于 Active Controller 能响应的最早 Record(因为 Active Controller 可能在该 Broker 重启期间生成了新的快照并清理了历史 Record), Active Controller 会返回**最新的快照 ID**, Broker 将首先获取该快照并导入到本地, 随后开始正常的**副本复制**过程.

新 Broker **启动**时时流程也是类似的, 只是绝大多数情况下请求初始偏移量会使上述逻辑走到先同步快照的逻辑分支中.

![when-snapshot-is-read](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_062.png)

## 横向伸缩

Kafka 的**存算分离**设计体现在 Broker 负责存储, 消费者及以消费者为基础的框架(如 Kafka Streams, ksqlDB)负责计算. Kafka 集群**横向伸缩**在存储层通过 Partition 数量控制, 在计算层通过**消费者组**(Consumer Group)配置和消费者数量控制.

![img](/images/Kafka-%E5%8E%9F%E7%90%86/guide-kafka-partition-img4.png)

### 消费者组

消费者在构造时必须指定从属于某个消费者组. 消费者订阅 Topic 后, Topic 以 Partition 为单位**划分**给同一个消费者组里的不同消费者. 换言之, 一个消费者可以订阅多个 Topic, 也可能被指派消费一个或多个 Topic 下的多个 Partition 的任务, 但**同一 Partition 在同一消费者组中只会被一个消费者消费**.

基于这种设计, 我们为 Kafka 集群**扩容**时应同时考虑 Partition 数量和消费者组下的消费者数量. 比如集群有 4 个 Partition, 1 个消费者组包含 4 个 消费者, 如果观察到 Broker 产生了消息堆积并且预估堆积原因是消费者数量导致性能不足, 那仅加入新消费者并不解决问题, 新消费者会由于此前的原因始终处于空闲状态, 直到我们增加对应的新 Partition. 

Record 根据 Key 进入不同 Partition, 不同 Partition 可以被不同消费者消费, 因此集群支持**并行**生产和消费. 同一 Partition 在同一消费者组中只会被一个消费者消费, 因此集群保证消息**在消费端有序**. 此前我们在生产者请求章节介绍过 Kafka 如何保证消息在生产端有序. 消息在生产端, Broker 和消费端均保证顺序, 因此整体也保证顺序.

![kafka-consumer-group](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_064.png)

### Group Coordinator

Partition 与消费者组内的消费者之间的**委派关系**(Assignment)是**动态**的, Partition 或消费者数量变化都可能使集群调整委派关系以重新平衡负载. 委派关系的建立和调整通过消费者组的 **Group Coordinator** 协调, Group Coordinator 使用**内部 Topic** `__consumer_offsets` 存储**消费者元数据**以跟踪消费者, 这个 Topic 包含多个 Partition.

![group-coordinator](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_065.png)

#### 路由

通常 Kafka 集群有多个 Group Coordinator, 用于提升不同消费者组的协调效率, 消费者需要确定所属组受控于哪个 Group Coordinator.

消费者启动后先向任意 Broker 发送 **FindCoordinatorRequest**, 包含其消费者组 ID. Broker 通过消费者组 ID 的**哈希**值**映射**到内部 Topic 的一个 Partition, 后续该消费者组的**消费者元数据**都将通过该 Partition 存储, 该 Partition 副本集的 Leader 即为该消费者组的 Group Coordinator. Broker 将该 Group Coordinator 的位置返回给消费者.

![group-startup-find-group-coordinator](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_066.png)

#### 委派过程

消费者找到 Group Coordinator 后, 需要向 Group Coordinator 发送 **JoinGroupRequest** 以申请加入消费者组, 该请求同时包含该消费者**订阅哪些 Topic**.

Kafka 为了提供**灵活性**, 将 Partition 和组内消费者间**委派关系**的建立交由消费者组内一个消费者来设定, 这个消费者称为 **Group Leader**. Group Leader 由 Group Coordinator 选择, 通常是消费者组内最早向 Group Coordinator 发出 JoinGroupRequest 的消费者.

收到 JoinGroupRequest 后, Group Coordinator 会为消费者分发一个在消费者组内唯一的**成员 ID**. 对于来自 Group Leader, Group Coordinator 还会额外返回当前消费者组的**成员列表**和**订阅申请**.

![group-startup-members-join](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_067.png)

Group Leader 收到成员列表和订阅信息后, 将根据**可配置的 Partitioner** 为 Partition 和组成员生成**委派关系**, 然后将**结果**及**自己的成员 ID** 通过 **SyncGroupRequest** 向 Group Coordinator 发送. 组成员也会发送该请求, 但只包含自己的成员 ID. Group Coordinator 会将**来自 Group Leader 的委派关系**返回给各个**组成员**, 最后组成员根据委派关系开始**消费**各自的 Partition.

![group-startup-partitions-assigned](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_068.png)

#### 委派策略

与前文在生产者请求章节介绍的分片规则类似, Group Leader 的 Partitioner 也支持多种委派策略以根据订阅申请和成员列表按不同规则生成委派关系. 由于 Group Leader 也是消费者, 因此除了下述内置策略, Group Leader 也可以注册**自定义规则策略**.

##### Range

**Range 策略**会将**每个 Topic 的 Partition 依次**分配给消费者组内的消费者, 第一个 Partition 分配给第一个消费者, 第二个 Partition 分配给第二个消费者, 以此类推.

这种委派策略会使负载**向靠前的消费者集中**, 如果消费者数量大于最大的 Partition 数量, 多出的消费者将处于空闲状态. 这种有潜在**负载倾斜**的委派策略主要用于特定场景, 比如需要在消费端处理**数据流 Join**, 如两个 Topic 的 Partition 的数量相同, 那么在默认或 Uniform Sticky Partition 分片规则下这两个 Topic 中 Key 相同的 Record 会分别写入序号相同的 Partition, 再根据 Range 策略被**同一个消费者**消费.

![range-partition-assignment-strategies](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_069.png)

##### Round Robin

**Round Robin 策略**会将**所有 Partition 依次**分配给消费者组内的消费者, 第一个 Partition 分配给第一个消费者, 第二个 Partition 分配给第二个消费者, 以此类推.

这种委派策略会比 Range 策略更加**均衡**.

![round-robin-and-sticky-strategies](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_070.png)

##### Sticky

**Sticky 策略**虽然与生产端分片规则中的 Uniform Sticky 名字接近, 但在逻辑上却并无太大关系. 这种委派策略是 Round Robin 策略的一个变种, 目标是优化在后文介绍的**再平衡**过程中委派关系的辩护程度, 以优化该过程的性能.

#### 进度跟踪

在上述设计下, 由于一个 Partition 只会被**一个**消费者**按序**消费, 因此进度追踪的逻辑比较简单, 只需记录消费者已经消费的偏移量. 实际实现是消费者向 Group Coordinator 发送 **CommitOffsetRequest**, 包含已经消费的偏移量, 然后 Group Coordinator 将该偏移量写入此前的**消费者元数据** Topic 中.

![tracking-partition-consumption](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_071.png)

当消费者组中的消费者重启时, 它需要**从上次中断的偏移量继续消费**. 为了得到这个偏移量, 他需要向 Group Coordinator 发送 **OffsetFetchRequest**. Group Coordinator 从消费者元数据 Topic 中获取该消费者**最后提交的偏移量**并返回. 如果该消费者是首次启动或加入消费者组, 消费者元数据 Topic 中没有改消费者的消费进度, 此时消费者根据配置决定从**最早**或**最新** Record 开始消费.

![determining-starting-offset-to-consume](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_072.png)

此前我们介绍过副本集 Follower 通过 FetchRequest 提交已复制的偏移量, Leader 通过该偏移量跟踪 Follower 进度. **Follower 复制**和**消费者消费**虽然过程类似, 但不是等价概念, 因此不要将这两种进度追踪方式搞混.

#### 故障恢复

本节介绍 Group Coordinator 如何保证**高可用**. 此前我们介绍过 Group Coordinator 是消费者元数据 Topic 按消费者组 ID 映射的 Partition **副本集**的 Leader, 因此如果 Leader 节点故障, 会执行前文介绍过的副本集 Leader 选举和副本调和过程. 消费者在老 Group Coordinator 失联后会重新走前文介绍过的路由规则找到新 Group Coordinator, 或在老 Group Coordinator 恢复上线后被通知.

![group-coordinator-failover](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_073.png)

### 再平衡

前文提到, 消费者组是 Kafka 为了实现**计算层横向伸缩**而存在的设计, 因此在 **Partition 或消费者数量变化**后, 重新平衡消费者间的负载是消费者组的必要特性, 这个过程称为**再平衡**(Rebalance). 具体来说, 以下情况会触发再平衡的发生:

* 消费者组初始化.
* 消费者和 Group Coordinator 间心跳超时, 导致其从消费者组中被踢除.
* 消费者显式加入消费者组或从消费者组中移除.
* 订阅申请中的 Topic 新增了 Partition.
* 订阅申请包含了通配符, 并且有新的满足条件的 Topic 被创建.

![consumer-group-rebalance-triggers](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_074.png)

当 Group Coordinator 识别到上述情况发生时, 它将在消费者组内的消费者下次发送**心跳**或 **OffsetFetchRequest** 时通过响应通知这些消费者开启一轮新的再平衡.

![consumer-group-rebalance-notification](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_075.png)

#### Stop-the-World

Kafka 早期为再平衡提供了一版**朴素实现**, 即在需要再平衡时**停止**消费者组内所有消费者的消费, **撤回委派关系**, 并让消费者重新发送 JoinGroupRequest 和 SyncGroupRequest 以再次**申请加入**消费者组. 消费者委派关系被撤回后,  消费者会清理上次委派过程中维护的**中间状态**, 并在接收新委派关系后重新构建.

![stop-the-world-rebalance](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_076.png)

这种实现有两个明显的问题:

第一个是再平衡后所有消费者都需要**重新构建**中间状态, 意味着**重复消费**被委派 Partition 中的一部分 Record. 如果在两次委派中, 某些 Partition 和消费者间的关系没有改变, 这种行为行为就产生了**性能浪费**.

![stop-the-world-problem-rebuilding-state](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_077.png) 

第二个是再平衡期间需要**暂停所有消费者**的消费, 这也是 Stop-the-World 名字的由来. 类似于在前一个问题中提到的, 一些 Partition 与消费者在两次委派中关系不变, 因此理论上可以不中断消费.

![stop-the-world-paused-processing](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_078.png)

上述问题使 Kafka 早期的再平衡饱受诟病, 所以 Kafka 后续提供了一些改进方案.

#### Sticky

**Sticky 实现**解决了朴素版本中第一个问题, 方式是将消费者的**状态清理时机推迟**到新委派过程结束后. 如果某个 Partition 与某个消费者间的委派关系没有变, 就可以避免不必要的状态重复构建.

![avoid-needless-state-rebuild-stickyassignor](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_079.png)

#### Cooperative Sticky

**Cooperative Sticky 实现**解决了朴素和 Sticky 版本中的第二个问题, 方式是将再平衡**拆分**为决策和执行**两个阶段**.

在**决策**阶段, Group Leader 根据变更后的 Partition 和消费者生成新的委派关系, 并识别其中变更的部分. 随后变更的委派关系会被撤回.

![avoid-processing-pause-cooperativestickyassignor](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_080.png)

在**执行**阶段, 撤回的委派关系会指派给新消费者, 过程与此前类似. 整个过程中, 没有变更委派关系的消费者既无需清理和重建中间状态, 也无需暂停消费.

![avoid-processing-pause-cooperativestickyassignor-2](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_081.png)

#### 静态关系

在实践中, 如果没有弹性伸缩诉求, 故障的消费者又能很快恢复上线, 那么性能最好的再平衡是不要执行再平衡, 为此 Kafka 提供了**静态关系实现**.

在这种实现中, 消费者组内的每个消费者都有**静态 ID**, 消费者退出时不会向 Group Coordinator 发送 LeaveGroup 请求, 因此 Group Coordinator 在消费者心跳超时前不会发起再平衡, 继而使消费者重新上线后可以立即恢复消费.

![avoid-rebalance-with-static-group-membership](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_082.png)

## 生产消费语义

### 生产者请求

前文介绍过:

* Kafka 如何保证消息在 **Broker 中不丢失**:
  * **副本集**提供存储可靠性性.
  * **水印机制**屏蔽易失数据对消费者的可见性.
* Kafka 如何保证消息在**消费端不丢失**:
  * 控制面如何**跟踪进度**, 消费者如何**确认消费**.

本章节补充介绍 Kafka 如何保证消息在生产端不丢失, 不重复, 并基于这些特性实现事务.

#### 确认规则

Kafka 支持生产者配置**确认规则**(Acks), 以供开发者在数据可靠性和生产者请求响应延时间间取舍.

如果将 acsk 配置为 0, 生产者发送消息后不会等待来自 Broker 的响应, **即发即忘**. 如果副本集 Leader 写入失败, 或在数据复制到其他 Follower 前宕机触发新的选举, 消息就会丢失.

![producer-acks-0](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_088.png)

如果将 acks 配置为 1, 生产者发送消息后会等待消息**写入副本集 Leader**, 但不会等待消息复制到其他 Follower. 如果在数据复制到其他 Follower 前宕机触发新的选举, 消息就会丢失.

![producer-acks-1](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_089.png)

如果将 asks 配置为 all 或 -1, 生产者发送消息后会等待消息**写入 ISR 中的所有副本**. 这也是 Kafka **默认**的确认规则. 这种规则提供了更高的可靠性, 但也带来了更大的响应延迟.

![producer-acks-all](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_090.png)

前文在 Follower 失效章节介绍过 Topic 粒度的配置 `min.insync.replicas`, 其含义是集群在该 Topic 的 ISR 中至少有**多少副本**才接受向 Topic 中**写入**新 Record, 与 `acks = all` 结合可以实现仅当集群中多数节点可用才允许写入, 进一步提升**数据可靠性**.

![topic-min-insync-replicas](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_091.png)

#### 生产端幂等

由于网络原因或集群选举导致的生产者重试可能在 Broker 写入**重复**或**乱序**的 Record.

![Diagram showing how producer retries and network errors can lead to message duplication in Apache Kafka.](/images/Kafka-%E5%8E%9F%E7%90%86/Adv_Idempotent_Producer_1.jpg)

举个例子, 生产者向 Leader 写入 `m1, m2, m3` 并等待 Record 复制到其他 Follower, Follower 复制并确认 `m1, m2` 后 Leader 宕机. 此时从生产者角度看, 请求没有被响应, 依此前介绍的**请求确认**和 **Leader 失效**处理流程, 生产者会向新 Leader 重试请求. 如果新 Leader 接受写入, Broker 中就会出现重复的 `m1, m2`, 并且新的 `m1` 在老的 `m2` 之后, 破坏了原有的 Record 顺序.

为避免上述情况, Kafka 实现了 Record 的**生产端幂等**. 启用该功能后, 生产者会以**生产者 ID** 和**自增序号**为每个 Record 生成**唯一标识符**并携带在生产者请求中, Broker 最新标识符持久化在元数据中. 当这些 Record 因重试而再次来打 Broker 时, Broker 会判定其标识符小于最新标识符而返回**重复投递**相关错误.

生产端幂等特性需要通过生产者配置 `enable.idempotence = true` 启用, 在 Kafka 3.0 之后默认启用.

![producer-idempotency](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_092.png)

#### 全过程有序

结合生产端幂等, 重新总结 Kafka 如何保证**消息有序**:

* 默认分片规则将生产者投递的 Key 相同的 Record **按序发送**到 同一 Partition 所在的 Broker.
* Broker 的网络线程**按序接收**生产者请求, 并通过自增序号**去重过滤**.
* Record **按序写入** Partition 的追加式物理结构 CommitLog.
* 消费者通过偏移量**按序消费** Partition 中的 Record.

![end-to-end-ordering](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_093.png)

### 事务

与数据库一样, 对消息队列的读写有时也需要**事务**.

以转账场景为例, 消费者从**上游** Topic `transfers` 消费一条转账事件并向**下游** Topic `balances` 生产两条余额变动记录, 如果这些行为间不具备**原子性**就可能出现**仅部分余额变动记录生产成功**的情况, 并且这种不一致很难通过重试维持**数据一致性**. Kafka 广泛应用于与上述示例类似的, 以**消费-处理-生产**(consume-transform-produce)为模型的**流处理**场景. 在该场景中, **事务**与 **Exactly-Once 语义保证**几乎是等价概念,  Kafka Streams 的上述特性底层就通过 Kafka 的事务 API 实现.

![why-are-transactions-needed](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_095.png)

#### 出错场景

如前所述, **At-Least-Once** 语义可以通过各个环节的重试及存储的可靠性保证, 而 **Exactly-Once** 语义在前文介绍的过程中却有可能因为以下原因而破坏:

1. `producer.send()` 可能在**一次消费**过程中本地重试而使余额变更记录多次入队. 前文在**生产端幂等**章节介绍过 Kafka 如何避免这一问题, 此处不再重复. 启用事务特性时 Kafka 会自动开启生产端幂等特性.
2. 应用在消费转账事件, 计算并写出余额变动记录后, **确认成功消费**转账事件前宕机, 重启后会**再次消费**转账事件, 导致余额变更记录被重复写出.
3. 在分布式场景下, 应用可能因宕机或暂时失去响应被编排系统**重启**, 或因负载变化而**横向伸缩**(新增或移除实例), 这些情况可能导致多个实例(一个活跃实例和若干僵尸实例)同时持有和处理同一消息.

下图演示了 2 发生的一种情况, 在首次消费过程中仅 Alice 的余额变更记录被写出, 经由故障恢复后重新消费写出了 Alice 和 Bob 的月变更记录, 导致 Alice 的余额多变化了一次:

![system-failure-without-transactions](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_098.png)

#### 事务实现

事务可以拆解为**原子性**(**A**tomicity), **一致性**(**C**onsistency), **隔离性**(**I**solation)和**持久性**(**D**urability). 前文已经介绍了 Kafka 如何通过副本集与 ISR 设计提供一致性和持久性, 后文主要关注**原子性**和**隔离性**的实现, 内容主要来自 [KIP-89](https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging) 设计文档.

##### 概念

如前所述, Kafka 通过 **Group Coordinator** 和**消费者元数据 Topic** 跟踪消费进度, 确认消费即提交偏移量更新本身也是一次元数据 Topic 写入, 因此保证**消费-处理-生产**的原子性本质就是保证分布式场景下**多个 Topic 写入的原子性**. Kafka 的分布式事务方案是改进版**二阶段提交**(**2** **P**hase **C**ommit, 2PC), 为实现该协议, 引入了如下概念:

* **Transaction Coordinator**: 即二阶段提交中的 Coordinator 角色, 用于维护事务状态并**协调各组件提交或回滚事务**, 其高可用方案和选举过程均与前文介绍过的 Group Coordinator 类似. Kafka 的 Transaction Coordinator 还承担额外的如 PID 分配等职责, 后文介绍.
* **Transaction Log**: Transaction Coordinator 用于持久化**事务状态**而使用的内部元数据 Topic, 也称为**事务状态元数据 Topic**. 代码命名为 `__transaction_state`. 与此前介绍过的其他元数据 Topic 如集群元数据 Topic `__cluster_metadata` 和消费者元数据 Topic `__consumer_offsets` 类似.
* **Control Message**: 当事务提交或回滚时写出到业务 Topic 中的特殊消息, 用于**标记**此前消息的可见性, 也称为 Marker, 包括标记提交的 Commit Marker 和标记回滚的 Abort Marker.
* **TransactionalId**: 支持在客户端通过配置指定的**生产者唯一标识**, 目的是将生产者关联到特定 Transaction Coordinator 及 Transaction Coordinator 能及时踢除僵尸实例. 代码命名为 `transactional.id` 或 `txn.id`. 与生产者 ID(PID) 不同, TransactionalId 在生产者重启后不应改变, 以供 Transaction Coordinator 进行关联. 如果多个生产者实例设定了相同的 TransactionalId, 先启动的会被视为僵尸实例而被 Transaction Coordinator 踢除, 在程序行为上表现为抛错退出.
* **生产者 Epoch**: Transaction Coordinator 为保证任意 TransactionalId 都只存在一个活跃实例的手段, 与前文介绍的 Leader 选举过程中改的 Epoch 原理类似.

##### 数据流

有了上述概念, 结合下图介绍一次完整的**事务写入**流程:

![img](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka%20Transactions%20Data%20Flow.png)



上图中, 方角矩形代表一台机器, 底部的圆角矩形代表 Kafka 内部的 Topic 或 Partition, 对角圆角矩形代表 Broker 中的逻辑实体, 箭头代表 PRC 或写入操作, 这些操作的顺序与箭头旁边的需要正相关, 以下介绍的需要与图中箭头的序号对应:

###### 1. Transaction Coordinator 寻址

Transaction Coordinator 是协调事务的中枢, 因此应用使用事务前需要先找到 Transaction Coordinator 的地址. 这个过程与通过消费者组 ID 到 Group Coordinator 的行为类似, 应用向任意 Broker 发送 **FindCoordinatorRequest**, Broker 通过应用提供的 TransactionalId 的哈希值与事务状态元数据 Topic 的 Partition 数量取模关联生产者与 Transaction Coordinator.

###### 2. 获取生产者 ID

找到关联的 Transaction Coordinator 后, 应用需要通过 **InitPidRequest** 获取服务端分配的生产者 ID(PID). 生产者 ID 与 TransactionalId 的异同前文已有介绍.

当设定 TransactionalId 时, 应用会将其携带在 InitPidRequest 中, Transaction Coordinator 将从元数据查找已为该 TransactionalId 分配的生产者 ID 或将本次新分配的生产者 ID 写入元数据中以保证映射关系的稳定. 除了分配生产者 ID, Transaction Coordinator 还将:

* 增加生产者 ID 对应的 Epoch, 继而阻止僵尸实例后续更新事务状态. 
* 恢复(提交或回滚)未完成的事务.

完成后返回, 此时应用可以开始新的事务.

当未设定 TransactionalId 时过程就简单很多, 应用会被分配新的生产者 ID, 此时 Kafka 对应用的事务保证仅能停留在一次会话内.

###### 3. 开启事务

应用通过 `beginTransaction()` 调用开启新的事务. 在应用实际写出任意 Record 前, 这只是客户端本地的状态变更, 因此这一步骤并不体现在数据流图中.

###### 4. 消费-处理-生产循环

应用进入事务实际执行阶段, 通常相对较长并伴随多次对 Partition 的写出.

**4.1**: 每当当前事务涉及对一个新 Partition 的写出时, 应用需要先通过 **AddPartitionsToTxnRequest** 向 Transaction Coordinator 报备该 Partition, 以便 Transaction Coordinator 后续在事务提交或回滚时向该 Partition 写出 **Control Message**. 当应用记录当前事务的涉及的首个 Partition 时, Transaction Coordinator 还会开启该事物的**计时器**.

**4.2**: 记录完成后, 应用即可通过**生产者请求**向业务 Partition 写出 Record. 生产者请包含生产者 ID, Epoch 和序列号.

**4.3**: 应用完成业务 Partition 的写出后需要确认本次消费成功, 即向 Group Coordinator 提交偏移量更新. 与此前类似, 同样分为两个步骤, 应用首先通过 **AddOffsetCommitsToTxnRequest** 向 Transaction Coordinator 报备涉及的 Partition 和偏移量, 同时还需提交消费者组 ID, 以便 Transaction Coordinator 可以关联应用对应的 Group Coordinator.

**4.4**: 其次通过 **TxnOffsetCommitRequest** 向 Group Coordinator 提交实际的偏移量更新, 与事务中的其他写操作类似, 这一更新在事务提交前对外并不可见. 上述过程中 Group Coordinator 也会校验应用生产者 ID 和 Epoch 的合法性以避免僵尸实例.

###### 5. 提交或回滚事务

上述过程完成后, 应用需要通过 `commitTransaction()` 或 `abortTransaction()` 提交或回滚事务, 前者使 4 中的变更对下游可见, 后者则使其隐藏.

**5.1**: 提交和回滚均通过 **EndTxnRequest** 完成, 但携带不同属性, Transaction Coordinator 收到该请求后将事务状态更新为 `PREPARE_COMMIT` 或 `PREPARE_ABORT`..

**5.2**: Transaction Coordinator 向报备过的 Partition 写出 **Control Message**, 根据提交和回滚分别对应 Commit Marker 和 Abort Marker. Control Message 包含生产者 ID, 用于隔离来自不同生产者的事务消息. 前文介绍过, 同一生产者对同一 Partition 的消息是严格有序的, 因此不存在两者间**不存在并行事务**, 简单状态的 Control Message 足以分隔不同事务间的消息.

**5.3**: Transaction Coordinator 将事务状态更新为 `COMMITED` 或 `ABORTED`.

由于前文介绍过的 Topic 底层存储 Commit Log 是仅追加结构, 因此上述提及的元数据更新均通过日志追加合并过程完成.

对于开启事务的 Record, 如果消费者将**事务隔离级别**设置为**读已提交**, 那么其在消费时将过滤未被 Commit Marker 标记为已提交的数据, 后文将详细介绍.

##### Exactly-Once

结合以上理论, 我们回归转账案例, 分析一次故障恢复和一次成功提交过程中 Kafka 如何 Exactly-Once 语义及数据一致性.

###### 故障恢复

如下是上述场景中的前半部分:

1. 应用找到 Transaction Coordinator, 用其 **TransactionalId** 向后者换取关联**生产者 ID** 及 **Epoch**.
2. 应用从 `transfers` Topic 中获取一条转账事件, 并通知 Transaction Coordinator **开始新事务**.
3. 应用计算并生成余额变动记录, 向 Transaction Coordinator **报备**将发生变化的 Topic `balances`  的目标 Partition.
4. 应用依次向这些目标 Partition **写出**余额变动记录, 假设先写出 Alice 的 $10 扣减记录.

![system-failure-with-transactions-2](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_099.png)

假设此时应用崩溃重启, 按前文介绍的事务流程:

1. 重启后的应用会通过相同的 **TransactionalId** 找到相同的 Transaction Coordinator 并换得相同的**生产者 ID**, 但  Transaction Coordinator 会根据事务状态元数据判定当前存在**未完成的事务**, 因此其将**增加 Epoch** 以避免潜在的僵尸实例再次更新事务状态, 并向受影响的 Partition 写出 **Abort Marker**.
2. 应用已经写出的**不一致数据**会在消费端由于**缺少必要的 Commit Marker** 及**事务隔离级别设置为读已提交**而被**丢弃**.

![system-failure-with-transactions](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_100.png)

###### 成功提交

假设应用能够成功完成所有写出并确认消费, Transaction Coordinator 将向这些 Partition 写出 Commit Marker 并更新事务状态, 使这些变化对下游业务可见.

![systems-with-successful-committed-transaction](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_101.png)

##### 隔离级别

消费者支持设置事务隔离级别, 如果设置为读已提交, 则消费时只会从 Broker 拉取到**最新稳定偏移量**(**L**ast **S**table **O**ffset, LSO)之前的 Record. LSO 由 Broker 维护, 其值为仍未完成事务涉及的最小偏移量. 换言之, 在上述设定下 Broker 只会返回**已提交或已回滚**的数据. 返回的数据包含标识提交或回滚的**元数据**以供客户端库函数进行**缓冲和过滤**. 最终用户只会读到**已提交**的数据.

![consuming-transactions-with-read-committed](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_102.png)

#### 性能讨论

二阶段提交的缺陷是随之带来的性能下降风险, 但其对 Kafka 的影响是有限的, 主要从以下几个方面考虑:

* 事务状态管理元数据, 进度追踪元数据和业务数据都依托于 Kafka Topic 维护而无需外部通信, **集成度高**.
* 与前文介绍的其他场景类似, Kafka 会**缓冲并批量处理**内部 RPC, 从而降低相关 Overhead. 用户可以通过参数控制事务提交间隔在**端到端延迟**和**吞吐**之间取得平衡.
* 根据前文对其实现细节的介绍, Kafka 开启事务特性后的影响是主要是**写放大**, 需要写出额外的事务状态日志和 Control Message, 但 Kafka Topic 底层存储结构 Commit Log 为类 LSM 树结构, 相较传统存储结构**能够更好地应对高写负载**.

根据 [Confluent 的测试结果](https://www.confluent.io/blog/transactions-apache-kafka/), 将事务提交间隔设置为 100ms 并以 1KB 为 Record 大小模拟最大吞吐量测试, 开启事务只会带来 3% 的性能下降. 这一数据仅适合作为参考, 在实践中由于工作负载特征的不同, 实际降幅还需要结合业务进行论证.

#### 外部一致性

Kafka 的 Exactly-Once 语义保证仅限于 Kafka 的集群状态和数据, 在应用中维护外部状态并不受上述机制的保护, 这与 Flink 等项目是类似的.

![interacting-with-external-systems](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_105.png)

## 资源回收

Kafka 有多种机制决定何时可以移除 Record 以回收资源.

### 基于时间淘汰

Kafka 支持将 Topic 中的数据保留指定时长后删除, 这种策略逻辑比较简单. 如前所述, 数据在保留期间可被消费者多次消费.

由于 Kafka 以 Segment 为单位执行清理, 因此 Record 的删除可能存在延迟, 仅当其所属的 Segment 中全部 Record 都满足清理条件后文件才会被移除.

![time-based-retention](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_109.png)

### 基于 Key 合并

Kafka 支持将 Topic 中的数据按 Key 进行覆盖合并, 仅保留最新的 Value, 这一过程也称为**收缩**(Compaction), 这与前文在集群元数据快照章节介绍过的收缩过程类似.

![topic-compaction-key-based-retention](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_110.png)

这种策略将 Topic 这一**物理上仅追加写入**的物理结构转化为了**逻辑上的键值存储**结构, 使其适合用于状态存储, ksqlDB 表或 Kafka Streams KTable 等场景. 对于如 CDC 场景等持续更新的数据集, 这种策略也使 Topic 能避免无限膨胀的前提下持续承载数据变化.

![usage-and-benefits-of-topic-compaction](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_111.png)

#### 收缩过程

Kafka Topic 的收缩过程与 RocksDB 的 [Compaction](https://github.com/facebook/rocksdb/wiki/Compaction) 或 GC 算法中的 Compact 都有相似之处.

Kafka 首先要从 Topic 的 Commit Log 下的所有 Segment 文件中选择一部分作为收缩对象. 收缩过程开始前, Segment 文件可以分为两类, 一类是经历过历史收缩过程的 **Clean Segment** 文件, 这类 Segment 文件中的键值已经过合并, 不存在重复键, 另一类则是其后新生成, 可能包含重复键的 **Dirty Segment** 文件. 一般会从 Dirty Segment 文件中从旧到新选择若干连续项参与收缩, 一次收缩的 Segment 文件数量取决于回收线程的可用内存大小. 此外, 由于 Commit Log 是追加结构, 最新的 Segment 文件可能仍出于活跃状态, 因此不会参与收缩过程. 上述过程类似于选择待合并的 SSTable 或待回收的内存 Region.

![compaction-segments-to-clean](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_112.png)

清理线程会按偏移量顺序遍历选中的 Dirty Segment 文件并构建 **Map 结构**, 新 Value 对应的偏移量会覆盖同 Key 的旧 Value 对应的偏移量. 由于选中的 Segment 文件数量和大小可控, 因此生成的 Map 大小也可控.

![compaction-build-dirty-segment-map](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_113.png)

Map 构建好后, 清理线程从头扫描截至选中 Dirty Segment 文件的所有 Segment 文件, 包含 Clean Segment 文件, 对于每个 Record, 如果 Map 中存在同 Key 的偏移量并且**比当前偏移量大**或 Map 中存在该 Key 的**删除标记**, 则意味着该 Record 可以被**丢弃**, 否则需要被**保留**.

![compaction-deleting-events](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_114.png)

所有需要被保留的 Record 会写出到新的 Segment 文件. 由于 Record 数量减少, 新生成的 Segment 文件也可能减少. 新 Segment 文件中的 Record 保留原始偏移量, 因此相邻 Record 间的偏移量可能存在**空隙**, 消费者消费时能够正确处理这些空隙.

![compaction-retaining-events](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_115.png)

收缩过程的最后一步就是用新 Segment 文件**替换老 Segment 文件**并**记录检查点**, 即更新 Clean Segment 文件与 Dirty Segment 文件的边界以为下次收缩过程计划起点.

![compaction-replace-old-segments](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_116.png)

由于**事务 Control Message** 和 Key 的**删除标记**(也称为墓碑)对客户端有特殊含义, 需要避免因收缩被移除而破坏语义, 因此不纳入常规收缩过程. Kafka 对此类 Record 的处理方式是**二阶段回收**, 当这些 Record 所属的 Segment 文件首次纳入收缩范围时, 这些 Record 会被标记**过期时间**, 并在后续收缩过程中进行判断, 根据是否过期决定移除与否, 即在局部退化为基于时间淘汰的策略.

![cleaning-tombstone-and-transaction-markers](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_117.png)

#### 收缩时机

一般情况下, 收缩由 **Dirty Segment 文件数据占比**触发, 阈值支持配置, 默认为 50%.

为避免业务高峰期过于激进或过于保守的收缩动作, Kafka 也支持通过配置设定**最大和最小收缩间隔**, 以起到**防抖**目的.

![when-compaction-is-triggered](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_when_compaction_is_triggered_v2.png)

#### 语义保证

基于上述行为, Kafka 对从基于 Key 合并的收缩 Topic 中消费 Record 的消费者的语义保证是其一定可见 Key 的**最新值**, 但不保证可见过程中变化的每一个值, 此外删除标记和 Control Message 存在独立设计, 保证其语义准确.

![topic-compaction-guarantees](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_119.png)

## 多级存储

Kafka 传统的存储方案存在几个问题:

* **存储成本**: Kafka 的吞吐性能受限于存储介质的性能, 因此一般会选择性能规格较高的设备, 但这在优化实时数据吞吐性能的同时, 也为历史数据的长期保留带来了较大的成本增长. Kafka 具备极强的数据堆积能力, 业务上我们也希望保留一段时期的历史消息以在必要时提供容错能力, 因此这种成本增长不能忽视.
* **弹性**: Kafka 的传统存储方案在容量弹性方面是与 Partition 和 Broker 绑定的, 这一点与云原生时代下强调的**存算分离架构**有一定的冲突. 为存储扩容常需要新增 Broker, 而这些 Broker 的计算资源则会有较多闲置和浪费. 此外, 由于 Kafka 的 Broker 承载了完整的数据存储职责, 因此当 Broker 故障替换或数量变化触发再平衡时, 数据恢复过程会涉及大量数据复制继而产生较大**性能开销**.
* **隔离性**: Kafka 中存在两种消费类型, 一种是数据未堆积情况下数据写入后很快被消费, 这时数据仍在 Page Cache 中可以很快返回. 另一种则是消费历史数据, 这时则需要从磁盘加载数据, 性能相对较差, 并可能阻塞网络线程的其他请求.

为解决上述问题, 一些云服务商为其商业化版本提供了**多级存储**(Tiered Storage)方案, 即划分**活跃热数据**和**历史归档冷数据**, 前者仍在 Kafka 本地存储, 后者则迁移到低成本大容量弹性存储如 HDFS 或 S3 中.

实现多级存储的云服务商包括但不限于 [AWS](https://docs.aws.amazon.com/msk/latest/developerguide/msk-tiered-storage.html) 和 [Confluent](https://docs.confluent.io/platform/current/clusters/tiered-storage.html). Kafka 的新时代竞品 [Apache Pulsar](https://pulsar.apache.org/) 支持更加细化的[存算分离架构](https://pulsar.apache.org/docs/3.2.x/concepts-architecture-overview/)(存储层由面向日志场景的分布式数据库 [BookKeeper](https://bookkeeper.apache.org/) 实现)和[多级存储方案](https://pulsar.apache.org/docs/3.2.x/tiered-storage-overview/), RocketMQ 也有[推进中的进程](https://github.com/apache/rocketmq/blob/develop/tieredstore/README.md).

Kafka 的社区版本目前提供处于**开放测试状态**的[多级存储实现](https://issues.apache.org/jira/browse/KAFKA-7739), 但仍存在[诸多限制](https://kafka.apache.org/documentation/#tiered_storage_limitation), 应该会在未来不断完善.

![tiered-storage-true-elasticity](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_123.png)

多级存储对应用层**不可见**, 换言之不影响生产和消费过程.

![writing-events-to-tiered-topic](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_125.png)

活跃的 Segment 文件始终留存在本地, 直至其刷盘冻结后成为**存储降级的备选**文件, 副本集 Leader 会根据**可配置的阈值**决定何时将其移动至远程存储.

![tiering-events-to-remote-object-store](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_126.png)

Broker 会根据元数据为 Partition 创建**逻辑视图**, 隐藏存储层实现细节.

![broker-logical-view-tiered-partition](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_127.png)

当消费者请求到来时, Broker 会根据逻辑视图决定如何取数, 如果数据在本地甚至 Page Cache 中会直接返回, 否则通过独立线程从远端**异步流式**返回. 数据在一定时间段内可能同时在本地和远程存在, Broker 会优先从本地返回.

![fetching-tiered-data](/images/Kafka-%E5%8E%9F%E7%90%86/Kafka_Internals_128.png)

多级存储在架构设计上并不依赖具体的存储层实现, 可以是云服务商提供的对象存储服务, 也可以是其他企业内部的存储方案, 只需要适配相应协议.

![tiered-storage-portability](/images/Kafka-%E5%8E%9F%E7%90%86/tiered-storage-portability.png)

## 结语

本文详细介绍了 Kafka 实现的方方面面, 包括支撑 Kafka 高吞吐性能指标的**架构设计**, 分布式场景下的**数据一致性**, **高可用**, **弹性伸缩**和**事务**实现等, 可以作为技术选型或了解 Kafka 技术细节的参考资料.

Kafka 相较传统消息队列如 RabbitMQ 在存储和消费模型上存在本质区别, 使其在某些场景中称为绕不开的选型方案. 此外如前所述, 在 Kafka 的架构设计中生产和消费端的 Client 也承担很多职责, 这也与轻 Client 实现的 AMQP 协议有较大差异, 如果团队编程语言生态中没有维护良好的 Kafka Client, 在选型时也要斟酌.  关于 RabbitMQ 和 AMQP 有时间我会再写一篇文章介绍.

除了 Kafka 技术原理本身, 本文列举出的 Kafka 设计文档如 [KIP-98](https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging) 和 [KIP-405](https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging) 在文档写法上同样值得学习, 这些文档既完整的记录了任务背景, 功能价值, 架构和代码封装设计, 又条理清晰简洁明了, 带来了很好的阅读体验.

## 参考资料

* [Kafka Official Document](https://kafka.apache.org/documentation/#design)
* [Kafka KIP-98 Transaction](https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging)
* [Kafka KIP-405 Tiered Storage](https://cwiki.apache.org/confluence/display/KAFKA/KIP-405%3A+Kafka+Tiered+Storage)
* [Kafka Internal by Confluent](https://developer.confluent.io/courses/architecture/)
* [Kafka Internal by Conduktor](https://www.conduktor.io/kafka/what-is-apache-kafka/)
* [DDIA Chapter 3](https://dataintensive.net/)

