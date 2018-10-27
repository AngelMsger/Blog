---
title: 遇见Redis
date: 2018-01-15 22:54:24
tags:
- Redis
- Database
- DevOps
- Optimization
categories:
- Database
thumbnail: "/images/遇见Redis.jpg"
---
Redis是一个开源，内存数据结构存储，常用作数据库，缓存和消息代理。它支持很多数据结构，例如字符串，散列表，列表，集合，能够进行范围查询的有序集合，位图，超文本和能够进行半径查询的地理空间索引。此外，Redis还提供许多高级特性。

# 基本命令
存储键值：{% codeblock "存储键值" %}SET foo:bar 1612{% endcodeblock %}
获取键值：{% codeblock "获取键值" %}GET foo:bar{% endcodeblock %}
仅在键不存在的情况下设置键值，如果键foo:bar已经有对应值了则不会做出任何改动：
{% codeblock "仅在键不存在的情况下设置键值，如果键foo:bar已经有对应值了则不会做出任何改动" %}SETNX foo:bar "Hello, Redis!"{% endcodeblock %}
值自增：{% codeblock "值自增" %}INCR foo:bar{% endcodeblock %}
你应当使用这条命令而不是先利用`GET ...`得到值，再利用`SET ...`存入增加的值，因为`INCR ...`能够保为你证原子操作。
删除键值：{% codeblock "删除键值" %}DEL foo:bar{% endcodeblock %}
获取所有键值：{% codeblock "获取所有键值" %}KEYS *{% endcodeblock %}
设置生存时间：{% codeblock "设置生存时间" %}EXPIRE foo:bar 30{% endcodeblock %}
单位为秒，在指定时间后键值将过期不可用。在执行此命令之前，你必须先使用`SET ...`存储键值。
查看键值剩余生存时间：{% codeblock "查看键值剩余生存时间" %}TTL foo:bar{% endcodeblock %}
单位为秒。若为-1，则这是一个持久的键值。若为-2，则是一个已过期的键值。
将带有生存时间限制的键值转换为持久键值：
{% codeblock "将带有生存时间限制的键值转换为持久键值" %}
PERSIST foo:bar
{% endcodeblock %}

# 数据结构

## 列表
在列表两端插入值：{% codeblock "在列表两端插入值" %}LPUSH/RPUSH foo "bar"{% endcodeblock %}
从列表两端移除值：{% codeblock "从列表两端移除值" %}LPOP/RPOP foo{% endcodeblock %}
按位置获取列表中的值：{% codeblock "按位置获取列表中的值" %}LINDEX foo 0{% endcodeblock %}
获取列表长度：{% codeblock "获取列表长度" %}LLEN foo{% endcodeblock %}
获取切片：{% codeblock "获取切片" %}LRANGE foo 0 -1{% endcodeblock %}

## 无序集合
加入一个值：{% codeblock "加入一个值" %}SADD foo "bar"{% endcodeblock %}
删除一个值：{% codeblock "删除一个值" %}SREM foo "bar"{% endcodeblock %}
判断特定值是否存在于集合中：{% codeblock "判断特定值是否存在于集合中" %}SISMEMBER foo "bar"{% endcodeblock %}
列出集合中所有元素：{% codeblock "列出集合中所有元素" %}SMEMBERS foo{% endcodeblock %}
求并集：{% codeblock "求并集" %}SUNION foo1 foo2{% endcodeblock %}
求交集：{% codeblock "求交集" %}SINTER foo1 foo2{% endcodeblock %}
求差集：{% codeblock "求差集" %}SDIFF foo1 foo2{% endcodeblock %}

## 有序集合
有序集合的许多操作与指令和无序集合很类似，只是将S换为Z。
加入一个值：{% codeblock "加入一个值" %}ZADD foo "bar"{% endcodeblock %}
由于带有顺序，有序集合支持获取切片。获取切片：
{% codeblock "获取切片" %}ZRANGE foo 2 4{% endcodeblock %}

## 散列表
在foo:bar内以键title插入一个值：
{% codeblock "在foo:bar内以键title插入一个值" %}HSET foo:bar title "Hello, World!"{% endcodeblock %}
{% codeblock "在foo:bar内以键title和content插入两个值" %}
HMSET foo:bar title "Hello, World" content "Wulawulawula..."
{% endcodeblock %}
获取单个值：{% codeblock "获取单个值" %}HGET foo:bar title{% endcodeblock %}
获取全部值：{% codeblock "获取全部值" %}HGETALL foo:bar{% endcodeblock %}
删除键值：{% codeblock "删除键值" %}HDEL foo:bar title{% endcodeblock %}
增加某一键对应值的量：{% codeblock "增加某一键对应值的量" %}HINCRBY foo:bar count 10{% endcodeblock %}

# 使用Pipline提升性能
在Web应用中，如果你想删除一个列表里所有的条目，大多数时候，你会把整个列表一次传输到服务器，而不是为每个条目单独发起一次请求，因为我们都知道建立连接所带来的开销会导致这样的做法性能低下。
在Redis中也一样，尽管Redis在1s内能处理100k个请求，但假如你选择单条处理，那可能会因为250ms的RTT而发现Redis只处理了4条。除了RTT成本，Redis服务器还会因为多次调用read()，write()系统调用而浪费性能。不过也不能一次性发送过多的指令，这可能会导致服务器消耗较多的内存，一个比较好的实践是分批发送，比如把每批限制在10k。具体的方法和我们开发工作使用的编程语言和库有关，可以在IDE里敲下pipeline试试。

# 将Redis应用于LRU Cache
由于Redis是一个内存数据库，访问速度非常快，也因此常常用来作缓存。Redis默认对内存使用没有限制，这意味着如果需要，它将使用它能够获取的所有内存。你可以通过在配置文件中写入`maxmemory 100mb`或动态的配置，或动态的使用`CONFIG SET ...`。当内存不足时，Redis将根据预先指定的策略删除键值，目前有以下几种策略：
1. noeviction：返回异常
2. allkeys-lru：删除距离最后一次使用时间最长 (而不是使用频率最低) 的键值
3. volatile-lru：与前一规则类似，但仅尝试那些带有生存时间的键值
4. allkeys-random：随机删除键值
5. volatile-random：随机删除带有生存时间的键值
6. volatile-ttl：不但仅尝试带有生存期限的键值，并且有限选择剩余生存时间更短的

你应该根据实际情况选择一个合适的策略，`INFO`命令输出结果中的命中次数也许可以帮助你。有三个值得一提的细节：
1. Redis对于内存使用的限制是在每一次用户请求之后，如果发现内存超出限制则根据指定策略抛出异常或移除部分键值并释放空间，这意味着如果用户的单次执行的指令需要很多的内存，那么在短时间内Redis的内存占用量有可能会超出限制。
2. Redis的LRU策略并非总能选取最有候选键值，实际上大多数时候Redis都是在做近似选择以节省开销。
3. 在Redis4.0之后新加入了两个LFU策略，与LRU不同的是LFU将尝试对那些最少使用的键值动手，而无论他是否最近才被使用过。这两个新加入的策略名为`allkeys-lfu`和`volatile-lfu`，你可以去官网看看文档，不过目前并不保证这是一项已经可以应用于生产环境的功能。

# 总结
除以上内容外，Redis还提供一些其他特性，比如我们可以利用Redis轻松地实现观察者模式和分布式锁，[官方文档](https://redis.io/documentation)中有更详细的介绍，我也会在未来在本篇文章中补全。对于Redis事务，存储结构，复制集及更高及的话题，我同样会在今后的文章中涉及。

# 参考资料
[Redis Documentation](https://redis.io/documentation)
