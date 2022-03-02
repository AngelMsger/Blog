---
title: MongoDB索引原理
date: 2021-08-11 23:37:21
tags:
- MongoDB
- Database
- Optimization
categories:
- Database
thumbnail: "/images/banner/MongoDB索引原理.jpg"
typora-root-url: ../../source/
---

索引是数据库在原始数据外**额外维护**的**用于提升查询性能**的**数据结构**, 如为B树. 这些数据结构的特性能够显著降低数据库查询所需遍历的数据量, 或协助数据库保证结果集的顺序. MongoDB的索引的本质与其他数据库大同小异.

以下是MongoDB官方提供的示意图, 可以看到, 在该索引定义下, 数据首先按照用户ID升序排序, 相同用户ID则按照分数降序排序:

![index-compound-key.bakedsvg](/images/MongoDB%E7%B4%A2%E5%BC%95%E5%8E%9F%E7%90%86/index-compound-key.bakedsvg.svg)Single Field 

MongoDB针对**不同的数据类型**提供了较为**丰富的索引类型**, 如常规的单列索引, 联合索引或针对二维数据的Geo索引, 和针对全文搜索场景的文本索引等. 本文主要讨论常规的单列索引和联合索引的实现原理, 及MongoDB的索引命中策略.

# 单列索引和联合索引

**单列索引**(Single Field Indexes)和**联合索引**(Compound Indexes)是几乎所有数据库都支持的索引类型.

正如名称中所指出的, 单列索引即针对特定列维护的索引结构, 由于MongoDB使用**集合**(Collection)和**文档**(Document)来描述其存储的表和行数据, 因此列的概念在此处也表述为**字段**(Field). MongoDB支持对常规字段和内嵌文档的常规字段建立单列索引.

联合索引则是建立在多个列上的索引. 与其他数据库类似, 联合索引对列的顺序是敏感的, 并且查询是否命中索引同样遵循基本的前缀匹配原则. 如以下索引定义:

```javascript
db.collection.createIndex({ "item": 1, "location": 1, "stock": -1 });
```

其命中情况如下:

```javascript
// 命中 items: 1
db.collection.find({ item: "Banana" });
// 仅能命中 items: 1
db.collection.find({ item: "Banana", stock: { $gt: 5 } });
// 完整命中索引, 并可以利用索引的有序性
db.collection.find({ item: "Apple", location: "California" }).sort({ stock: -1 });
```

在单列索引中, 字段的升降序对查询的性能没有任何影响. 即使结果集需要升序排序, 而索引结构定义为降序, MongoDB仅需从结果集下界反向遍历即可达到相同效果. 但在联合索引场景下, 如果查询对结果集中某些列的顺序与索引定义不同, MongoDB就无法通过简单的调整遍历顺序来直接利用索引的有序性了.

# Mutikey Indexes

除了常规的标量数据类型外, MongoDB还支持对数组类型的字段建立索引, 即Multikey Indexes, 我也不知道这个名词现在的公认翻译是什么, 就不自己生造了, 后文这个和类似的词都直接用原始的名字. 对于这类索引, MongoDB实际将数组中的多个元素拉平作为多个项构建在索引中, 结构如下:

![index-multikey.bakedsvg](/images/MongoDB%E7%B4%A2%E5%BC%95%E5%8E%9F%E7%90%86/index-multikey.bakedsvg.svg)

基于这样的结构和逻辑, 不难理解由此带来的特性和限制, 如:

* 在Mutikey Indexes上加Unique限制, 最终表现为数组在不同文档间互相Unique, 但在单文档内可以重复.
* 单个联合索引定义中最多允许存在一个字段使用Mutikey Indexes.

