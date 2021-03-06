---
title: 说说MySQL存储引擎，索引及基本优化策略
date: 2018-01-02 02:47:45
tags:
- MySQL
- InnoDB
- Database
- DevOps
- Optimization
categories:
- Database
thumbnail: "/images/banner/说说MySQL存储引擎，索引及基本优化策略.jpg"
typora-root-url: ../../source/
---
本文讨论一些听起来比增删改查更高级的内容，也许是迈进MySQL大门的第一步。

# 存储引擎
与Oracle, SQL Server这些数据库不同，MySQL提供了多种存储引擎。什么是存储引擎？存储引擎其实就是一套对于数据如何存储，查询，更新，建立索引等接口的实现。不同存储引擎特性有所不同，我们根据需要进行选择，比如包含ETL操作的[OLTP](https://en.wikipedia.org/wiki/Online_analytical_processing)(联机交易处理)项目中我们通常选择InnoDB，而对于读操作较多几乎没有写操作的[OLAP](https://en.wikipedia.org/wiki/Online_transaction_processing)(联机分析处理)则选MyISAM的更多。因此并不是大家都用环境相似，同一版本的MySQL，能够使用的特性就是一致的。在MySQL终端中查看支持的存储引擎，默认值及简单介绍：

```mysql
SHOW ENGINES;
```

在我使用的版本(Ver 15.1 Distrib 10.1.31-MariaDB)中，存在10种存储引擎，默认使用的是InnoDB。

![可用的存储引擎](/images/%E8%AF%B4%E8%AF%B4MySQL%E5%AD%98%E5%82%A8%E5%BC%95%E6%93%8E%EF%BC%8C%E7%B4%A2%E5%BC%95%E5%8F%8A%E5%9F%BA%E6%9C%AC%E4%BC%98%E5%8C%96%E7%AD%96%E7%95%A5/%E5%8F%AF%E7%94%A8%E7%9A%84%E5%AD%98%E5%82%A8%E5%BC%95%E6%93%8E.png)

在创建表时指定使用的存储引擎：

```mysql
CREATE TABLE IF NOT EXIST mytest (foo VARCHAR(32)) ENGINE=InnoDB;
```

查看已创建表使用的存储引擎：

```mysql
SHOW CREATE TABLE mytest;
```


尽管MySQL提供了多种数据存储引擎，但我们接触最多的还是MyISAM和InnoDB，这两种存储引擎都已经过了大量的实践，非常可靠。

## MyISAM
MyISAM是早期版本(MySQL 5.5.5之前)默认的存储引擎，特点是**不支持**事务，外键和行级锁。使用表级锁，加锁粒度比较大，开销比较小，但也因此增加了在做数据更新时冲突的可能性，比较适合查询为主的业务。值得一提的一个细节是，MyISAM将数据表行数直接存储起来，因此不含条件的count搜索将在常数时间内得到结果。MyISAM支持B-tree/FullText/R-tree索引类型。

## InnoDB
新版本已经把InnoDB作为默认的存储。相比MyISAM，InnoDB有比较完善的事务支持，同时也支持外键和行级锁。这些特性使得InnoDB在面对数据更新密集型的场景下依然是非常强大的解决方案。InnoDB的索引在缓存数据的同时也缓存自身，这将导致更大占用更多的存储空间，下文将更详细的讨论索引相关的内容。InnoDB也支持我们常用的auto_increment属性。InnoDB支持Hash/B-tree索引类型。

## 其他存储引擎
如前所述，MySQL还提供其他多种存储引擎，如用于临时表，存储位置位于内存中，常用来作缓存的MEMORY，和将数据压缩归档存储的ARCHIVE，但我个人对这些存储引擎接触不多，大家可以参阅网上的其他资料。

# 索引
索引是一种为了加速对数据表的查询操作而维护的一种**额外的数据结构**。我们通常根据某些规则(如针对某一经常出现在where条件中的列)对表建立索引，这样之后对于这类**查询就会非常高效**。在MySQL中表的主键及建立的外键(如果被支持)上会被自动添加索引。但也正因为索引是一种额外维护的数据结构，因此它不但会**占用更多的存储空间**，也会**为数据的插入和更新带来额外的负担**。谨慎而合理的为表添加索引，是提高MySQL性能的重要手段。关于索引的更详细内容，[MySQL索引背后的数据结构及算法原理](http://blog.codinglabs.org/articles/theory-of-mysql-index.html)写的非常好。

## B-Tree和B+Tree索引
B-Tree是一种平衡多叉树，查询过程中通过待查询的值与比较节点内的值，决定匹配返回找到，或不匹配时通过某一分支向下层递归查找，或不能继续递归查找时返回查找失败。在这样的树中查找算法的时间复杂度降低至对数级别，非常高效。但为了维护这颗B-Tree的有序性质与平衡，数据在插入和更新时将带来额外的开销，关于平衡树的增删改查的具体算法，感兴趣的同学可以通过查询阅读一下，这里就不讨论了。

B-Tree具有很多变种，B+Tree就是其中之一。B+Tree与B-Tree的显著区别之一是，B+Tree的数据全部存储于叶子节点，因此每一次查询一定会到达树的底层。现代数据库经常为B+Tree做一些额外的优化，例如在底层节点之间增加指针，从而对于叶子节点形成一种类似链表 (或一种长的比较特别的跳表) 的结构，以加速遍历和区间查询。红黑树等经典数据结构并没有被用作数据库的主要实践，原因与磁盘IO性能考虑等较为抽象的原因有关，这在本文末尾的链接页面中有所提及。

## MySQL中的索引
MySQL支持的多种存储引擎对于索引有着不同的支持。

在MyISAM存储引擎中，默认使用B+Tree作为索引方式。在MyISAM中，数据与索引是分离的，B+Tree的叶子节点中存储着指向真实数据的指针，查询过程在经过索引后的到这一指针，根据指针指向的值返回结果。MyISAM的索引方式被成为非聚集索引。

InnoDB存储引擎同样使用B+Tree作为索引方式，但具体实现并不相同。在InnoDB中，数据本身就存储于根据主键组织的B+Tree之上，因此InnoDB的表中不能没有主键。另一个需要提及的特点是，对于基于InnoDB存储引擎的表上的其他辅助索引，同样基于B+Tree，但最终的到的值是对应数据的主键，换言之，一次查询过程将会分为两个阶段，在经过一轮索引后，如果查找成功，会持有对应数据的主键值再去存储着真实数据并基于主键组织的B+Tree上查找一次。InnoDB的索引方式被称为聚集索引。

# 实践

## 基本性能分析手段
查看某一张表上存在着哪些索引：

```mysql
SHOW INDEX FROM mytest;
```

如果想了解某一条查询语句对于索引的使用，可以使用在命令前加入`EXPLAIN`。显示最近使用EXPLAIN的查询所消耗的时间：

```mysql
SHOW PROFILES;
```

## 基本优化策略
了解了索引背后的基本原理，以及基本的分析手段，为我们高效使用索引提供了思路。如何对DB进行优化是一件比较精致的事，与具体情况有关。很多不当的SQL语句会使精心建立的索引无能为力，比如多个(>1)范围列，缺少联合索引中的中的某些列(最糟糕就是缺少最左匹配中的第一列)，含有函数或表达式，选择性(按索引规则过滤的非重复数量与全部记录数量的比值)过低等。
除了针对高频查询操作添加的辅助索引外，主键的选择也有一定学问。结合InnoDB存储引擎索引方式与底层存储细节，简单的来说，使用一个与逻辑无关的自增字段作为主键是个好主意。

# 参考资料
[MySQL索引背后的数据结构及算法原理](http://blog.codinglabs.org/articles/theory-of-mysql-index.html)
