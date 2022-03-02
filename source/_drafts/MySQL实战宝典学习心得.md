---
title: MySQL实战宝典学习心得
date: 2021-08-23 10:00:31
tags:
- MySQL
- InnoDB
- Database
- DevOps
- Optimization
categories:
- Database
thumbnail: "/images/banner/MySQL实战宝典学习心得.png"
typora-root-url: ../../source/
---

# 表结构设计

## [数字类型](https://dev.mysql.com/doc/refman/8.0/en/numeric-types.html)

### 整型

MySQL支持SQL标准提供的`INT`, `SMALLINT`和非标准的`TINYINT`, `MEDIUMINT`和`BIGINT`. 区别主要在于存储空间占用和对应的取值范围, 详见[官方文档](https://dev.mysql.com/doc/refman/8.0/en/integer-types.html). 对于整型类型, 有`SIGNED`(默认)和`UNSIGNED`属性区分. 在实践中, 如无必要, 不建议刻意使用`UNSIGNED`, 原因在于默认情况下, MySQL要求`UNSIGNED`列间的运算结果仍须为`UNSIGNED`, 因此可能在某些统计和分析场景带来问题.

#### 整型与自增列

建表过程中, 一个常见做法是建一个整型列并标记为自增, 作为该表的主键. 这一做法在如今分布式架构下已不再适用, 对于现有已使用自增列做主键的场景, 需要注意以下问题:

* 使用BIGINT而非INT类型, INT的上限值约为42亿, 在流水/日志表中很容易达到最大值, 后期变更表结构成本巨大.
* MySQL 8之前自增值可能因实例重启等原因出现回溯现象.

### 浮点和高精度

MySQL提供了`FLOAT`, `DOUBLE`, `NUMERIC`和`DECIMAL`. `FLOAT`和`DOUBLE`为浮点类型, 其指定精度和标度(小数点后位数)的语法为非标准SQL语法, 且在高版本MySQL中已标记为弃用, 因此已不推荐在生产中使用. `NUMERIC`实际由`DECIMAL`实现. 对于高并发场景业务中的固定精度和标度的数字列类型选择(如电商场景中的金额), 更推荐转化为整型存储.

### 资金字段设计

电商等业务中常常需要存储金额, 如用余额等. 常规的做法是试用`DECIMAL`, 并精确到分, 如`DECIMAL(8, 2)`. 但更好的做法是将这类值转换单位(如从"元"改为"分")并改用整型存储. 主要有以下原因:

* `DECIMAL`需要指定精度和标度, 对扩展性存在限制. 如`DECIMAL(8, 2)`最大值仅在百万级别, 而统计局的GDP数字则可能为数十万亿, 难以统一.
* `DECIMAL`应其编码方式而使其计算效率不如整型.

## [字符串](https://dev.mysql.com/doc/refman/8.0/en/string-types.html)

MySQL提供了多种字符串类型, 如`CHAR`, `VARCHAR`, `BINARY`, `BLOB`, `TEXT`, `ENUM`和`SET`等. 其中最常用的是`CHAR`和`VARCHAR`.

`CHAR(N)`用于存储固定长度字符, N的含义是字符数, 而不是字节数. N的范围为0~255. `VARCHAR(N)`用于存储变长字符, N的范围为0~65536. 超出这一范围则可以考虑转为其他类型如TEXT, BLOB, 但绝大多数场景, `VARCHAR`已经足够使用了.

### 字符集(CHARSET)

对于以字符存储的列来说, 除了关注其长度限制还应关注其字符集属性. 同一字符在不同字符集编码下对应的二进制值不同. 有些字符在特定字符集中无法存储. 如MySQL的`utf8`字符集不能存储[emoji表情](https://en.wikipedia.org/wiki/Emoji). 对于大多数场景, 推荐将字符集设置为`utf8mb4`, 这也是MySQL 8之后的默认字符集配置. 此前则为`latin1`.