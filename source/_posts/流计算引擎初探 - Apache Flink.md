---
title: 流计算引擎初探 - Apache Flink
date: 2019-10-19 20:00:00
tags:
- Big Data
- Streaming
- Flink
categories:
- Big Data
thumbnail: "/images/banner/流计算引擎初探 - Apache Flink.jpg"
typora-root-url: ../../source/
---

[Flink](https://flink.apache.org)是一个针对有状态的，有界或无界数据的流计算引擎，同类产品还包括[Storm](http://storm.apache.org)和[Spark Structured Streaming](https://spark.apache.org/docs/latest/structured-streaming-programming-guide.html)。Flink遵循Kappa架构，同时支持在线流计算和离线批处理，并提供内存级别IO速度和理论上无限制的横向扩展性。

![flink-home-graphic](/images/%E6%B5%81%E8%AE%A1%E7%AE%97%E5%BC%95%E6%93%8E%E5%88%9D%E6%8E%A2%20-%20Apache%20Flink/flink-home-graphic.png)

## 特性

### 同时处理有界流和无界流

数据总是不断的由事件产生的，如用户的动作，传感器的数值，事务的结束和机器运行产生的日志。这些数据可以被视为流，并分为两种类型：

1. **无界流**(Unbounded Stream)中的数据持续产生并且没有明确的结束，他们必须被持续的处理。因此等到所有输入都以就绪才能执行的任务在这种场景下是无法运作的。为保证结果的一致性，无界流处理对拉取数据的顺序非常敏感。
2. **有界流**(Bounded Stream)有着明确的起止，因此可以在处理执行前拉取全量的数据。全量数据可以在内存中重新排序，因此对拉取的顺序并不敏感。对有界流的处理也被称为**批处理**(Batch Processing)。

![bounded-unbounded](/images/%E6%B5%81%E8%AE%A1%E7%AE%97%E5%BC%95%E6%93%8E%E5%88%9D%E6%8E%A2%20-%20Apache%20Flink/bounded-unbounded.png)

Flink能够同时处理无界流和有界流。Flink将对固定大小的离线数据的批处理视为有界流的流计算，但在底层使用专用的数据结构与算法以优化这种场景下的性能开销。

### 任意部署

Flink依赖计算所需的各种资源以完成任务。Flink可以依托在[YARN](https://hadoop.apache.org/docs/current/hadoop-yarn/hadoop-yarn-site/YARN.html)，[Mesos](https://mesos.apache.org/)和[Kubernetes](https://kubernetes.io/)这样的集群资源管理平台上工作，也可以作为Standlone集群独立部署。

得益于Flink对资源管理的接口化定义，Flink在概念上和实现逻辑上都不与特定资源管理平台深度耦合。

### 无限制的横向扩展性

Flink被设计为在任意规模下进行有状态的分布式流计算。即使应用被并行化为数千个任务也可以在集群上正确执行。Flink并没有CPU，内存，磁盘和网络IO的明确限制，并且大量资源在Flink中仍然易于管理。Flink的异步增量检查点算法能够在对计算逻辑影响很小的前提下保证结果的的一致性(包括Exactly-Once性质)。

### 内存级性能

Flink应用的状态处理被优化为始终仅需读写本地内容。包括检查点机制在内的状态处理，大多都可以在内存级的延迟内完成。

![local-state](/images/%E6%B5%81%E8%AE%A1%E7%AE%97%E5%BC%95%E6%93%8E%E5%88%9D%E6%8E%A2%20-%20Apache%20Flink/local-state.png)

# 核心概念

## 数据流编程模型

### 抽象层次

![levels_of_abstraction](/images/%E6%B5%81%E8%AE%A1%E7%AE%97%E5%BC%95%E6%93%8E%E5%88%9D%E6%8E%A2%20-%20Apache%20Flink/levels_of_abstraction.svg)

在最底层，开发者可以直接面向**原始状态流**，注册事件时间和处理时间回调函数以完成复杂的逻辑。在实践中开发人员通常不需要直接面向数据流编程。

第二层封装为**DataStream Api**和**DataSet Api**，分别对应无界流和有界流。这层封装包括了对数据的转换(Transform)，Join，聚合(Aggregate)和窗口及状态管理等。在这一层数据模型在实际编程中映射至类。

第三层封装为**Table Api**，这是一种围绕表的声明式DSL。在这一层中结构化数据流被进一步抽象为表，与关系型数据库类似，不同的结构化数据流映射为的表拥有对应的Schema，并且对数据提供了诸如Select, Project, Join, GroupBy, Aggregate等操作，同时也支持开发者自定义函数以适应复杂业务的需要。

在最高层，Flink将数据流处理抽象为**SQL**。Flink可以解析SQL语句并将其转化为对应Table Api的调用，因此其业务能力与表达力与Table Api近似。

开发者在实际开发中，可以根据业务复杂性，结合使用不同的封装层级。我们可以看到这种封装层级与Spark SQL和Spark Structured Streaming的封装非常类似，正是因为Spark在后续的发展中从Flink借鉴了许多优秀的想法。

### 应用逻辑

在Flink应用中，对有限数据的批处理同样被处理为流计算，因此问题的核心就仅仅是如何处理和转换数据流。从概念上讲，**数据流**(Stream)是不断到来的数据记录，而**转换**(Transformation)是将一个或多个数据流作为**输入**(Source)，经过一系列内含转换逻辑的**算子**(Operator)组成的**有向无环图**(DAG)，并产生一个或多个数据流作为**输出**(Sink)的过程。尽管Flink在某些场景中支持环路，但这里为了简化问题暂时忽略这一特性。

一个简单Flink应用代码如下：

![program_dataflow](/images/%E6%B5%81%E8%AE%A1%E7%AE%97%E5%BC%95%E6%93%8E%E5%88%9D%E6%8E%A2%20-%20Apache%20Flink/program_dataflow.svg)

上述逻辑按ID和时间窗口对数据进行聚合，尽管此处同样是为了简化问题将DAG退化为了链表，但在实际中Flink有能力应对即使复杂的多的场景。

### 并行模型

Flink中的数据流是分布式并行处理的。在应用执行过程中，数据流被划为多个**流分区**(Stream Partition)，对应的，处于下游的每个算子拥有多个**子任务**(Operator Subtasks)，这些子任务会以分布式的方式执行，意味着他们可能运行在不同线程，不同容器甚至是不同物理机器上。

划分子任务的数量被称为对应算子的**并行度**(Parallelism)，数据流的并行度通常与生产该数据流的算子的并行度一致。由于重分布行为的存在，同一个Flink应用的不同算子可能拥有不同的并行度。

![parallel_dataflow](/images/%E6%B5%81%E8%AE%A1%E7%AE%97%E5%BC%95%E6%93%8E%E5%88%9D%E6%8E%A2%20-%20Apache%20Flink/parallel_dataflow.svg)

正如上图所示，数据流从一个算子到达另一个算子有两种方式：

* **一对一**(One-to-One, Forward): 如上图Source与Map算子间的关系，这种方式将会保留分区数据边界及顺序，这也就意味着Map[1]看到的数据条目及顺序将与其上游Source[1]一致。
* **重分布**(Redistributing): 如上图Map与KeyBy/Window算子间的关系和KeyBy/Window与Sink算子间的关系。这种关系改变了数据流的分区，每个子任务将数据按规则发往不同的下游子任务。在Flink中，如KeyBy)(根据键哈希)，Broadcast(广播)和Rebalance(随机)等算子都对应这种方式。在这种方式下，尽管来自上游的数据在其流内分别保持顺序，但聚合后的结果的顺序却具有不确定性。

### 窗口

对数据流的聚合(如Count和Sum)与对有限数据集的批处理在很多方面并不相同，比如数据流内的数据有可能是无穷的(即Flink概念中的无界流)。Flink将对这种流的聚合操作按窗口划分范围，如“最后5分钟内数据的数量”和“最新100条数据的和”，对窗口完备支持也是Flink相较于同类产品(如Storm)的显著优势之一。

按纬度划分，窗口分为时间维度(如每30秒)和数据纬度(如每100条数据)。按类型划分，窗口分为**翻滚窗口**(Tumbling Window，窗口间无重叠)，**滑动窗口**(Sliding Window，窗口间有重叠)和**会话窗口**(Session Window，按闲置时间拆分)。

![window](/images/%E6%B5%81%E8%AE%A1%E7%AE%97%E5%BC%95%E6%93%8E%E5%88%9D%E6%8E%A2%20-%20Apache%20Flink/window.png)

### 时间

时间是流计算中的一个重要的指标，在开发过程中，我们主要关注3个时间点：

* **事件时间**(Event Time): 即事件创建时间，通常由上游业务逻辑产生。
* **采集时间**(Ingestion Time): 是事件到达Source算子的时间。
* **处理时间**(Processing Time): 每个算子执行时的本地时间。

![event_ingestion_processing_time](/images/%E6%B5%81%E8%AE%A1%E7%AE%97%E5%BC%95%E6%93%8E%E5%88%9D%E6%8E%A2%20-%20Apache%20Flink/event_ingestion_processing_time.svg)

Flink依赖这些时间完成实际的流计算和数据快照，并将对应回调函数接口暴露给开发者以实现更加底层的逻辑。

### 状态

尽管存在一些简单的数据流处理逻辑仅依赖独立的事件，但大多数计算逻辑都需要在处理过程中保留多个事件间的某些状态，这种计算逻辑被称为**有状态的**(Statful)。

在有状态的计算逻辑中，Flink提供近似键值存储的方式来维护状态信息，此处的键值存储可以时内部的JVM HashMap，也可以是外部的持久化方案，如RocksDB。也正因这种键值的存储方式，因此状态信息的存取仅支持在KeyBy之后，那些有“键”概念的数据流，状态的值与数据中的键相关联。结合前文提及的重分布特性，这种数据与键，键与状态的对齐方式保证了状态更新是一个本地行为，因此可以在不引入分布式事务的前提下保证结果的一致性。

![state_partitioning](/images/%E6%B5%81%E8%AE%A1%E7%AE%97%E5%BC%95%E6%93%8E%E5%88%9D%E6%8E%A2%20-%20Apache%20Flink/state_partitioning.svg)

### 检查点和容错机制

Flink通过结合**流重放**(Stream Replay)和**检查点**(Checkpointing)来实现容错。一个检查点对应于各算子在某一时间点的状态。整个数据流计算过程可以从某个检查点恢复全部状态进而维持计算结果的一致性(指Exactly-Once语意)。

对检查点设置间隔是一个权衡容错和故障恢复开销的方式。

### 批处理与流计算

Flink遵循Kappa架构，即将批处理视为有界的流计算，这一点与Spark Structured Streaming存在本质的不同，后者正相反，它将流计算视为许多个小型批处理。因此DataSet Api的本质只是特殊的流计算。因此前文提及的所有内容在Flink的批处理中仍然适用，但也存在细节上的不同，Flink针对有界流的批处理场景作了一些针对性的调整和优化，并提供一些在无界流中无法实现的对外接口。

## 分布式运行时环境

### 任务和算子链(Operator Chain)

在对分布式执行中，Flink将一些算子的子任务合并为任务(Task)。每个任务最重会由一个线程来执行。这是一种实用的优化：它降低了线程间切换，传递数据的开销，进而提升了整体吞吐量并降低了延迟。这一行为可以由开发者配置。

下图中描述的例子将子任务合并为5个任务，因此会产生5个并行的线程。

![tasks_chains](/images/%E6%B5%81%E8%AE%A1%E7%AE%97%E5%BC%95%E6%93%8E%E5%88%9D%E6%8E%A2%20-%20Apache%20Flink/tasks_chains.svg)

### Job Managers，Task Managers和Clients

Flink运行时包含两种进程：

* **JobManager**(也称为Master)：调度任务分布式执行，协调容错机制及恢复。集群中至少拥有一个JobManager，在高可用配置下可以有多个其中一个作为Leader，其余作为Standby。
* **TaskManager**(也称为Worker)：执行任务(更具体而言，是子任务)，缓冲并交接数据流。集群中至少拥有一个TaskManager。

这两种进程可以通过通过Standlone方式直接部署或部署在容器中，也可以运行在如YARN，Mesos和Kubernetes这样的资源管理平台上。TaskManager会尝试连接至JobManager，声明可用并请求任务。

**Client**并非Flink分布式运行时的一部分，仅用来准备数据流配置并提交至JobManager。此后，Client实际上就可以离线，也可以继续保持在线以获取数据流执行的过程信息。实际开发工作中，Client通常特指我们编写的Java/Scala程序或一个CLI命令(flink run ...)。

![processes](/images/%E6%B5%81%E8%AE%A1%E7%AE%97%E5%BC%95%E6%93%8E%E5%88%9D%E6%8E%A2%20-%20Apache%20Flink/processes.svg)

### 任务槽和资源

每一个TaskManager(Worker)就是一个JVM进程，并在多个线程中分别执行任务。TaskManager通过一种名为**任务槽**(Task Slot)的概念来控制其可一接受多少个子任务。

每个任务槽都代表了TaskManager资源的固定子集，比如配有3个任务槽的TaskManager，每个任务槽将拥有该TaskManager所管理内存资源的1/3。这意味着不同任务槽内执行的子任务不会相互竞争内存资源。但需注意，此处的资源目前仅指内存，而不包括CPU。

通过调整任务槽的数量，开发者实际上定义了的任务间的隔离性。举个例子，如果每个TaskManager上的只有一个任务槽，那么每个任务必须被分配一个独立的TaskManager，即一个独立的JVM实例；而如果每个TaskManager拥有多个任务槽，则会让多个任务共享同一个JVM实例。共享JVM实例的多个任务共享TCP连接(通过多路复用)和心跳信息，以及数据和数据结构，因此可以降低每个任务的实际开销。

![tasks_slots](/images/%E6%B5%81%E8%AE%A1%E7%AE%97%E5%BC%95%E6%93%8E%E5%88%9D%E6%8E%A2%20-%20Apache%20Flink/tasks_slots.svg)

默认配置下，Flink允许不同任务的子任务共享任务槽，只要他们来自同一个Job。因此在极端场景下，甚至可能在一个任务槽内执行了整个Job的Pipeline。这带来两方面的好处：

* Flink集群执行任务所需任务槽数与Job最高并行度相等，无需额外计算。
* 更好的资源利用率。如上图，如果没有任务槽共享，那资源部敏感的Source和Map算子子任务将不得不持有和资源敏感的KeyBy/Window算子子任务相同的内存资源；而有了任务槽共享，开发者通过将示例程序中的并行度由2提升至6以充分利用集群内的资源，同时保证资源敏感的子任务被公平分布在多个TaskManager之上。

![slot_sharing](/images/%E6%B5%81%E8%AE%A1%E7%AE%97%E5%BC%95%E6%93%8E%E5%88%9D%E6%8E%A2%20-%20Apache%20Flink/slot_sharing.svg)

### 状态持久化后端

用于保留计算状态的键值索引的数据结构取决于开发者配置的**状态持久化后端**(State Backend)，如内存中的HashMap，或外部RocksDB的键值存储。状态持久化后端的特性还将影响到检查点快照的生成。![checkpoints](/images/%E6%B5%81%E8%AE%A1%E7%AE%97%E5%BC%95%E6%93%8E%E5%88%9D%E6%8E%A2%20-%20Apache%20Flink/checkpoints.svg)



### 存储点

通过DataStream Api编写的程序可以从一个**存储点**(Savepoint)中恢复执行(而通过DataSet Api便携的程序由于其面向数据的有界性，通常可以直接进行完整的重新计算，根据前文对容错机制的讨论，Flink为优化这种计算的开销，在此场景下并未提供检查点机制)。存储点也让不丢失数据的前提下更新Flink集群变得可能。

存储点实际上是手动触发的检查点，会对当前应用状态进行快照并存储至状态持久化后端，因此存储点逻辑依赖于检查点实现。由于在应用执行过程中定期快照产生的检查点仅用于故障恢复，因此只有最新的检查点会被保留，但手动触发的存储点不会被自动过期。

# 编写示例程序

我们通过官方文档提供的示例程序演示基本的，基于DataStream Api实现的Flink应用。

维基百科提供一个IRC频道，输出条目编辑日志，包含了作者及修改内容，我们以这两个指标，基于滚动时间窗口编写应用，统计每5秒内发生的变更。示例程序提供了Connector，因此我们无需关注如何从IRC频道日志转化为数据流的细节。

通过Maven创建应用，由于我们演示从零开始的过程，因此删除自动生成的示例代码：

```shell
mvn archetype:generate \
    -DarchetypeGroupId=org.apache.flink \
    -DarchetypeArtifactId=flink-quickstart-java \
    -DarchetypeVersion=1.9.0 \
    -DgroupId=wiki-edits \
    -DartifactId=wiki-edits \
    -Dversion=0.1 \
    -Dpackage=wikiedits \
    -DinteractiveMode=false
rm wiki-edits/src/main/java/wikiedits/*.java
```

在`pom.xml`中引入相关依赖，如前文提到的，我们额外引入了针对维基百科IRC频道提供的Connector。注意，需要移除`org.apache.flink`和`org.apache.flink`依赖的`<scope>provided</scope>`，否则后续直接运行将会报错。如果是将程序提交至Flink运行，则可以忽略。

```xml
<dependencies>
    <dependency>
        <groupId>org.apache.flink</groupId>
        <artifactId>flink-java</artifactId>
        <version>${flink.version}</version>
    </dependency>
    <dependency>
        <groupId>org.apache.flink</groupId>
        <artifactId>flink-streaming-java_2.11</artifactId>
        <version>${flink.version}</version>
    </dependency>
    <dependency>
        <groupId>org.apache.flink</groupId>
        <artifactId>flink-clients_2.11</artifactId>
        <version>${flink.version}</version>
    </dependency>
    <dependency>
        <groupId>org.apache.flink</groupId>
        <artifactId>flink-connector-wikiedits_2.11</artifactId>
        <version>${flink.version}</version>
    </dependency>
</dependencies>
```

编辑目录下的`src/main/java/wikiedits/WikipediaAnalysis.java`并添加代码，其解释见备注：

```java
package wikiedits;

import org.apache.flink.api.common.functions.AggregateFunction;
import org.apache.flink.api.java.functions.KeySelector;
import org.apache.flink.api.java.tuple.Tuple2;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.datastream.KeyedStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.windowing.time.Time;
import org.apache.flink.streaming.connectors.wikiedits.WikipediaEditEvent;
import org.apache.flink.streaming.connectors.wikiedits.WikipediaEditsSource;

public class WikipediaAnalysis {
  // 程序入口
  public static void main(String[] args) throws Exception {
    // 创建执行环境，可以修改执行环境的相关参数，但此处略去。
    // 如果是批处理，则需要创建ExecutionEnvironment
    StreamExecutionEnvironment see = StreamExecutionEnvironment.getExecutionEnvironment();
    // 通过维基百科IRC频道提供的Connector封装添加Source算子
    DataStream<WikipediaEditEvent> edits = see.addSource(new WikipediaEditsSource());
    // 如前文提及，状态信息需要KeyedStream来支持。
    // 我们的业务关注不同的用户的编辑内容，因此以user为键。
    // 这种代码虽然看起来繁琐，但可以被简化为lambda表达式。
    // 毕竟我们所使用的Java与老一辈人认识的Java已经大不相同了，:)。
    KeyedStream<WikipediaEditEvent, String> keyedEdits = edits
      .keyBy(new KeySelector<WikipediaEditEvent, String>() {
        @Override
        public String getKey(WikipediaEditEvent event) {
          return event.getUser();
        }
      });
    // 声明我们的聚合计算：按用户每5秒统计修改内容。
    DataStream<Tuple2<String, Long>> result = keyedEdits
      .timeWindow(Time.seconds(5))
      .aggregate(new AggregateFunction<WikipediaEditEvent, Tuple2<String, Long>, Tuple2<String, Long>>() {
        @Override
      	public Tuple2<String, Long> createAccumulator() {
      	  return new Tuple2<>("", 0L);
      	}
        // 从原始数据中获取键值对。
      	@Override
      	public Tuple2<String, Long> add(WikipediaEditEvent value, Tuple2<String, Long> accumulator) {
      	  accumulator.f0 = value.getUser();
      	  accumulator.f1 += value.getByteDiff();
          return accumulator;
      	}
        // 汇总逻辑：直接返回。
      	@Override
      	public Tuple2<String, Long> getResult(Tuple2<String, Long> accumulator) {
      	  return accumulator;
      	}
        // 聚合逻辑：值直接想加。
      	@Override
      	public Tuple2<String, Long> merge(Tuple2<String, Long> a, Tuple2<String, Long> b) {
      	  return new Tuple2<>(a.f0, a.f1 + b.f1);
      	}
      });
    // 打印结果。
    result.print();
    // 执行流计算。
    see.execute();
  }
}
```

以上应用对应于前文提及的Client，它负责声明计算逻辑，构建计算图并提交至Flink集群。现在我们编译并执行这个应用：

```
mvn clean package
mvn exec:java -Dexec.mainClass=wikiedits.WikipediaAnalysis
```

将会看到类似下述输出：

```shell
...
4> (4.133.97.238,425)
6> (AnomieBOT,326)
4> (DB1985,3)
7> (Monkbot,-167)
1> (MisterCake,-7)
2> (Larry Hockett,-31)
8> (Billiekhalidfan,-21)
2> (Filedelinkerbot,-29)
7> (Monkbot,-78)
1> (7.205.106.254,140)
5> (Starship.paint,18)
2> (Filedelinkerbot,-19)
...
```

# 部署本地集群

## 部署和启动

Flink可以在Linux，MacOS和Windows下运行，其依赖Java 8.x 环境(截止文章编写时间，2019/10/14，Flink对11及更高版本的Java适配工作仍在进行中，详情可见[链接](https://issues.apache.org/jira/browse/FLINK-10725))。

确认Java环境后，直接从官网[下载页](http://flink.apache.org/downloads.html)下载最新版本的压缩包，解压并执行`bin/start-cluster.sh`即可。

也可以通过运行Docker容器来进行本地测试，需要注意对Flink提供的Web端口8081进行映射。

```shell
docker pull flink
cat > docker-compose.yml <<EOF
version: "2.1"
services:
  jobmanager:
    image: ${FLINK_DOCKER_IMAGE_NAME:-flink}
    expose:
      - "6123"
    ports:
      - "8081:8081"
    command: jobmanager
    environment:
      - JOB_MANAGER_RPC_ADDRESS=jobmanager

  taskmanager:
    image: ${FLINK_DOCKER_IMAGE_NAME:-flink}
    expose:
      - "6121"
      - "6122"
    depends_on:
      - jobmanager
    command: taskmanager
    links:
      - "jobmanager:jobmanager"
    environment:
      - JOB_MANAGER_RPC_ADDRESS=jobmanager
EOF
docker-compose up
```

此时访问本地地址http://localhost:8081，可以进入Flink Dashboard，本地集群启动成功。

![flink_dashboard](/images/%E6%B5%81%E8%AE%A1%E7%AE%97%E5%BC%95%E6%93%8E%E5%88%9D%E6%8E%A2%20-%20Apache%20Flink/flink_dashboard.png)

现在可以将Flink应用交由集群运行。

# 参考资料

1. [Flink官方文档](https://flink.apache.org)。
2. [Flink原理与实现：Window机制](http://wuchong.me/blog/2016/05/25/flink-internals-window-mechanism/)。
3. [美团点评基于Flink的实时数仓建设实践](https://tech.meituan.com/2018/10/18/meishi-data-flink.html)。