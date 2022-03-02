---
title: 故障隔离与Hystrix
date: 2022-02-25 14:44:46
tags:
---





故障隔离是微服务场景下经常提起的话题, 其核心关注点是不希望由某个具体功能场景引发的异常影响其他功能场景, 甚至持续扩散最终导致单个服务或整个集群的崩溃, 也就是我们常说的雪崩效应.

对于基于线程池的并发模型, 这样的场景很容易构造, 比如我们的服务的一项功能依赖某个上游服务的接口, 而上游的该接口出现了问题, 长时间不能响应, 并且我们对该请求没有设置过期时间或者过期时间设置的过长, 而刚好这一功能又在某个时间段被大量使用, 就会导致被阻塞的线程越来越多, 整个服务出现问题.

对于Node.js这样的响应式并发模型, 虽然不那么容易遇到连接挂起导致线程耗尽的问题, 但对于内存, 连接数等资源的问题同样存在. 举个具体例子, 简道云在前端事件功能场景下会对用户指定的服务器地址发起Http请求. 考虑到这是一个免费开放给所有用户的功能, 如果用户无意或恶意将配置该功能的分发给大量用户, 并约定在某个时间段一起访问填写, 则由简道云反向代理的大量前端事件请求有可能在对应时间点耗尽简道云自身服务节点的相关资源, 如触达Node.js的DNS瓶颈, 导致简道云内部服务调用失败, 从而影响其他正常访问的用户.

由于微服务架构的兴起, 此类问题变得非常常见, 因此也就衍生出很多针对该问题的开源框架. 比较出名的有Netflix开源的[Hystrix](https://github.com/Netflix/Hystrix), 历史相对悠久, 也是本文接下来的主要内容. 以及目前开源社区转向的[resilience4j](https://github.com/resilience4j/resilience4j). 关于两者的区别可以从Hystrix项目说明中[对于当前开发状态的描述](https://github.com/Netflix/Hystrix/blob/master/README.md#hystrix-status)和resilience4j的这篇[对比文档](https://resilience4j.readme.io/docs/comparison-to-netflix-hystrix)中大致了解.

相比我前面举的例子, 简道云实际业务中遇到由于数据库资源隔离性不足导致的可用性问题更常见, 后者的解决可能更多依赖基础设施上的隔离, 因此我没有用对应场景举例, 但相关场景对于信号量使用的封装依然可以借鉴本文的内容. 毕竟在业务代码中直接编写信号量逻辑既不利于统一维护和管理, 也降低了本身就比较复杂的业务代码更难阅读.

# Hystrix

[官方有一篇文档](https://github.com/Netflix/Hystrix/wiki/How-it-Works)介绍了Hystrix的核心原理, 这篇文章也是基于该文档与部门功能的源码实现讨论Hystrix如何实现故障隔离和熔断降级.

## 执行流程

### 1. 构造命令

首先我们将要隔离的业务逻辑封装为命令. Hystrix提供两种命令的抽象基类, `HystrixCommand`和者`HystrixObservableCommand`, 主要区别在于指令处理的数据是单个还是多个, 比如流式场景.

```java
HystrixCommand command = new HystrixCommand(arg1, arg2);
```

### 2. 执行命令

有多种方式触发命令的执行:

- [`execute()`](http://netflix.github.io/Hystrix/javadoc/com/netflix/hystrix/HystrixCommand.html#execute()): 阻塞并等待执行结果, 返回或抛出错误.
- [`queue()`](http://netflix.github.io/Hystrix/javadoc/com/netflix/hystrix/HystrixCommand.html#queue()): 返回一个`Future`对象, 可以稍后在需要使用时从该对象中获取或等待执行结果.
- [`observe()`](http://netflix.github.io/Hystrix/javadoc/com/netflix/hystrix/HystrixObservableCommand.html#observe()): 返回一个Hot Observable, 底层为`toObservable()`返回结果的复制流.
- [`toObservable()`](http://netflix.github.io/Hystrix/javadoc/com/netflix/hystrix/HystrixObservableCommand.html#toObservable()): 返回一个Cold Observable, 订阅时将触发真正的执行.

```java
K             value   = command.execute();				 // only HystrixCommand
Future<K>     fValue  = command.queue();					 // only HystrixCommand
Observable<K> ohValue = command.observe();         // hot observable
Observable<K> ocValue = command.toObservable();    // cold observable
```

关于Hot/Cold Observable, 实际上是[RxJava](https://github.com/ReactiveX/RxJava)中的概念, [文档](https://reactivex.io/documentation/observable.html)中有相关说明. 简言之, Hot Observable在创建后即开始发布数据, 随后订阅的消费者只能看到订阅时间之后发布的数据, 而Cold Observable则等待消费者订阅之后才开始发布数据. Hystrix的实现大量依赖的RxJava中的理念, 虽然对于执行流程而言理解与否并无大碍, 但想阅读源码则需要了解相关知识, 比如此处的`execute()`实际上也会转化为`queue().get()`, 而`queue()`内部又会转化为`toObservable().toBlocking().toFuture()`.

### 3. 结果是否命中本地缓存

如果命令开启了本地缓存并且缓存命中, 会从本地直接返回. 否则继续.

### 4. 断路器是否打开

首先检查断路器状态, 若为打开则会跳转至(8)来尝试获取一个降级后的结果(Fallback), 否则继续.

### 5. 资源是否耗尽

检查命令对应的线程池/队列/信号量是否耗尽(触达额度限制), 若耗尽则会跳转至(8)来尝试获取一个降级后的结果(Fallback), 否则继续.

### 6. 执行业务逻辑

通过下述方法之一来触发业务逻辑的执行:

- [`HystrixCommand.run()`](http://netflix.github.io/Hystrix/javadoc/com/netflix/hystrix/HystrixCommand.html#run()): 返回结果或抛出异常.
- [`HystrixObservableCommand.construct()`](http://netflix.github.io/Hystrix/javadoc/com/netflix/hystrix/HystrixObservableCommand.html#construct()): 返回一个Observable.

如果上述方法调用超时会抛出`TimeoutException`, 这一异常会被捕获, 即使任务的执行没有取消返回结果也会被丢弃.

### 7. 计算断路器健康指标



### 8. 获取降级的结果



### 9. 返回正确结果

