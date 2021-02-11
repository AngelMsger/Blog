---
title: InnoDB存储结构
date: 2020-03-05 13:54:02
tags:
- MySQL
- InnoDB
- Database
- DevOps
- Optimization
categories:
- Database
thumbnail: "/images/banner/InnoDB存储结构.png"
typora-root-url: ../../source/
---

本文介绍InnoDB数据存储结构, 为后续研究其锁和事务特性做准备.

# 简介

InnoDB是MySQL目前(8.0)的默认存储引擎, 主要具备以下特性:

- DML遵循**ACID**模型, 完整支持事务的各种隔离级别, 通过事务的提交, 回滚和崩溃恢复保护数据安全.
- 通过**行级锁**和**一致性非锁定读**提升并发性和性能.
- 通过维护**主键聚簇索引**, 在较小IO的情况下加速查询.
- 支持通过外键来保证多表数据一致性.

更多指标可以参考官方文档的[InnoDB 介绍](https://dev.mysql.com/doc/refman/8.0/en/innodb-introduction.html)及其子页面. 基于InnoDB的特性, 官方文档整理了一些[最佳实践](https://dev.mysql.com/doc/refman/8.0/en/innodb-best-practices.html), 可以作为常规使用时的准则, 本文主要整理MySQL的存储结构, 不展开讨论.

# 多版本控制

InnoDB是一个**多版本**存储引擎, 即它会跟踪数据变化的版本, 从而支持并发事务和事务回滚. 版本信息存储在表空间中名为回滚段的数据结构中, 并用来在事务回滚时实现"撤销", 同时也用来在一致性读时构建某个时间点上的数据**快照**.

在内部实现上, InnoDB在每行数据上添加了3个属性:

- 6-byte DB_TRX_ID为最近一次插入或更新该行的**事务编号**, 删除被视为更新, 但会打一个特殊的标志表示该行已被删除.
- 7-byte DB_ROLL_PTR为一个指向回滚段内Undo Log的**指针**, 撤销日志(Undo Log)在行更新后保留了如何将该行恢复为更新前状态的必要信息.
- 6-byte DB_ROW_ID为行插入时的**自增Id**, 当InnoDB自动生成聚簇索引时会使用这一字段.

回滚段中的撤销日志分为**插入撤销日志**和**更新撤销日志**. 插入撤销日志只在事务回滚时使用, 事务提交即可忽略. 更新撤销日志在随后的一致性非锁定读中还有可能被使用, 因此需要等到所有事务都不再需要该撤销日志来构建快照时才能被忽略.

因此即使事务只包含一致性非锁定读, 也需要定期提交, 否则, InnoDB将不得不一直保留这些撤销日志, 占用大量表空间中的空间.

在表空间中, 撤销日志占用的物理空间通常比插入或更新的行数据小很多.

在InnoDB多版本控制中, 执行`DELETE ...`不会立即在物理上删除该行的数据, 而是要等到该操作的撤销日志被忽略时才会执行. 物理删除被称为"**清理**(purge)", 在独立的垃圾回收线程中进行, 执行速度很快. 但如果以同样的速率进行行的插入和删除, 由于清理的滞后性, 可能产生大量的无效数据进而降低磁盘性能.

## 多版本控制与辅助索引

InnoDB多版本控制使其以不同的方式对待**聚簇索引**和**辅助索引**. 聚簇索引将被原地更新, 同时通过隐藏列中的指针指向撤销日志中的老版本数据, 而辅助索引既不原地更新也不维护撤销日志指针.

当辅助索引列被更新时, 旧的辅助索引记录将被标记为删除, 同时插入新的记录. 标记为删除的记录最终会被清理. 当辅助索引被较新的事务更新或被标记为删除时, InnoDB会查询聚簇索引, 在聚簇索引中检查DB_TRX_ID, 并根据查询返回正确版本的数据. 这种情况下, 不会使用覆盖索引([Covering Index](https://dev.mysql.com/doc/refman/8.0/en/glossary.html#glos_covering_index), 即通过辅助索引记录直接返回结果)技术. 然而, 如果使用了索引条件下推([Index Condition Pushdown, ICP](https://dev.mysql.com/doc/refman/8.0/en/index-condition-pushdown-optimization.html))优化, 并且`WHERE`条件可以仅通过索引进行评估, MySQL仍然会将查询条件下推至存储引擎. 如果未命中任何记录, 则可避免对聚簇索引的查询. 如果找到了记录, 即使这些记录被标记为删除, InnoDB也会查找聚簇索引.

# 架构

下图展示了InnoDB内存和磁盘结构, 后文将展开说明.

![innodb-architecture](/images/InnoDB%E5%AD%98%E5%82%A8%E7%BB%93%E6%9E%84/innodb-architecture.png)

## 内存模型

### Buffer Pool

**Buffer Pool**是InnoDB在主存中缓存访问过的表和索引数据的空间. Buffer Pool使得频繁使用的数据可以直接从内存中获取, 从而加速处理. 在专用的服务器上, 大约80%的物理内存会被用为Buffer Pool.

为提高大容量设备的读操作效率, Buffer Pool被划分为可包含多行数据的页面(Pages). 为了提高缓存的管理效率, Buffer Pool被实现为由页面组成的链表, 并通过LRU算法淘汰相对最少使用的数据.

了解如何将频繁访问的数据尽可能保留在缓冲池中从而提升缓存的命中率是MySQL调优过程中非常重要的一部分.

#### Buffer Pool的LRU算法

Buffer Pool以**链表**的形式组织, 并通过LRU算法的变种进行管理. 新读取的页面将被插入Buffer Pool链表的中间, 并将最近最少访问的节点从链表尾部踢出. 因此其形式大致为:

- 在链表头部, 子链为新的, 频繁访问的数据.
- 在链表尾部, 子链为老的, 较少访问的数据, 随着新数据的加入, 滞留在此的节点将被踢出.

![innodb-buffer-pool-list](/images/InnoDB%E5%AD%98%E5%82%A8%E7%BB%93%E6%9E%84/innodb-buffer-pool-list.png)

InnoDB会维护该链表, 默认情况下行为如下:

- 大约有3/8的缓冲池空间存放旧数据.
- 当InnoDB从外部加载新也至Buffer Pool中时, 会在新数据子链和老数据子链的交界处插入该页. InnoDB在**用户发起的行为**如SQL查询, 或自动执行**页面预加载**时会从外部将页面读入Buffer Pool.
- 从老数据子链中访问一个页面, 将会使这个页面**转变为新数据**, 从而将其移动至新数据子链. 新老数据子链中的数据都将随着其他数据的更新而**老化**, 最终, 长时间未使用的页面将从老数据子链中被**逐出**.

默认情况下, 通过查询读取的页面会自动移动至新数据子链, 从而在Buffer Pool中停留更长时间. 全表扫描, [mysqldump](https://dev.mysql.com/doc/refman/8.0/en/mysqldump.html)或不带`WHERE`的`SELECT`语句, 即使这些数据不会被重复使用, 也将导致大量数据页面被读入Buffer Pool, 同时踢出等量的老数据. 类似的, 预加载使用的数据即使只是一次性使用, 也将移动至新数据子链. 这些场景将导致可能被频繁使用的页面反而被推至老数据子链或成为踢出Buffer Pool的目标, 因此也是优化的重点场景.

#### Buffer Pool的配置和优化

InnoDB提供了很多影响Buffer Pool的配置项, 如大小, 分区, 预读取逻辑等, 可以查看[官方文档的相关页面](https://dev.mysql.com/doc/refman/8.0/en/innodb-buffer-pool.html), 此处不展开. 同时, `SHOW ENGINE INNODB STATUS`也会提供关于Buffer Pool的各项指标, 前文提到的文档页面也给出了各项指标的具体含义, 可以作为调优的参考.

### Change Buffer

**Change Buffer**是专门用于缓存对**不在Buffer Pool中的辅助索引页**修改的数据结构. 这些被缓冲的修改, 如`INSERT`, `UPDATE`或`DELETE`操作(即DML), 将在稍晚时在数据页被加载至Buffer Pool时被合并.

![innodb-change-buffer](/images/InnoDB%E5%AD%98%E5%82%A8%E7%BB%93%E6%9E%84/innodb-change-buffer.png)

与聚簇索引不同, 辅助索引通常不包含唯一性约束, 并且插入也更加随机, 同时, 由于更新和删除也有可能影响辅助索引中不相邻的页, 因此在稍后由其他操作触发的将辅助索引页引入Buffer Pool时再将这些修改进行合并, 可以避免立即从磁盘载入这些辅助索引页带来的大量随机I/O.

当系统空闲或将要慢停机时, 会执行一些清理操作, 从而将这些更改合并至磁盘. 相比立即写入, 后续执行的清理操作能够更高效的将一系列块写入磁盘. 当修改涉及的辅助索引或行记录较多时, Change Buffer的合并可能会持续数小时, 在此期间, 磁盘I/O会上升, 因此可能引起磁盘查询速度大幅降低. 即使MySQL服务重启, Change Buffer的合并也仍有可能持续.

在内存中, Change Buffer占用一部分Buffer Pool空间, 在磁盘上, Change Buffer是系统表空间的一部分, 用以在服务停止时缓冲对辅助索引的修改.

Change Buffer通过上述方式降低了DML对辅助索引频繁随机读写消耗过多I/O资源的可能性, 但会占用一部分Buffer Pool的空间. 如果实际应用中DML操作很少, 或表上没有很多辅助索引, 则可以配置调整Change Buffer数据缓存的类型(insert, delete等)和最大占用空间. 同样的, 可以通过`SHOW ENGINE INNODB STATUS`来查看Change Buffer的相关参数.

如果辅助索引或表主键包含降序规则, 则对应辅助索引不支持Change Buffer逻辑.

### 适应性哈希索引(Adaptive Hash Index)

**适应性哈希索引**是InnoDB的一项特性, 能够在特定荷载场景和Buffer Pool足够大的时让InnoDB表现的更像是一个有事务特性的内存数据库. 该特性需要手动启用.

当InnoDB通过对查询的监视和评估后认为一些数据会被经常访问, 它会使用索引键前缀和指针来构建这些数据的哈希索引, 从而可以直接查找其中的任何元素. 自适应哈希索引是分区的, 不同索引位于不同的分区上, 并受独立的锁保护.

是否构建索引取决于InnoDB的评估结果, 在某些荷载场景下, 适应性哈希索引带来的提升远大于其维护成本, 但在另一些场景下, 如LIKE运算符和%通配符的查询, 则不会从中受益, 而在多个并发Join时, 适应性哈希索引甚至可能加剧竞争. 在这些荷载场景中, 可以关闭此特性来降低不必要的性能开销. 是否需要开启此特性通常是难以直接推测的, MySQL文档建议在开启和关闭的环境下分别进行基准测试, 并以其结果作为配置调整的依据.

同样的, 可以通过`SHOW ENGINE INNODB STATUS`来查看适应性哈希索引的相关参数.

### Log Buffer

**Log Buffer**用于缓冲一部分将被写至磁盘日志文件的数据, 默认为16MB.

Log Buffer的内容会被定期刷写至磁盘. 较大的Log Buffer能能够允许规模较大的事务在提交前不需要将重做日志写至磁盘. 因此如果涉及DML的事务规模比较大, 可以适当调大Log Buffer以节省磁盘I/O.

Log Buffer的大小, 刷盘方式和频率均可通过配置参数控制.

## 存储模型

### 表(Tables)

#### 创建表

可以通过下述语句创建InnoDB表:

```mysql
CREATE TABLE t(foo INT PRIMARY KEY, bar CHAR(16)) ENGINE=InnoDB;
```

由于InnoDB目前是MySQL的默认存储引擎, 因此`ENGINE=...`可以被省略. 但考虑到脚本可能会被运行在自定义配置或其他版本的MySQL上, 通常会被显式保留.

InnoDB创建的表可以位于系统表空间, 也可以自动创建单独的表空间(通过`innodb_file_per_table`参数, 默认为`ON`), 还可以指定为特定的表空间(通过`CREATE TABLE ... TABLESPACE`语法).

当使用为每张表创建单独的表空间时, MySQL会为每一张表在数据目录下创建一个.ibd文件. 当使用系统表空间时, 则会使用一个已存在的文件, 同样位于该目录下. 当指定特定表空间时, MySQL将使用该表空间指定的文件, 该文件可以位于MySQL数据目录之外的其他位置.

在创建表时, InnoDB会自动添加该表所在的数据库名称作为前缀, 因此不同数据库下的同名表不会冲突.

有些场景下需要在外部创建表, 比如I/O管理, 空间管理或针对特定表的业务选择具有某些特性的存储设备. InnoDB支持在指定位置创建表. 在使用为每张表创建单独表空间的特性时, 可以通过以下语句指定对应文件所在的目录:

```mysql
CREATE TABLE t(foo INT PRIMARY KEY) ENGINE=InnoDB DATA DIRECTORY='/external/directory';
```

如使用上述语句时, 最终的目录结构为`/external/directory/dev/t.ibd`. MySQL不支持软链接, DATA DIRECTORY可以作为一种代替方式.

使用时需要注意以下事项:

- 必须提前在`innodb_directories`变量中加入该目录, 这是一个只读参数, 修改后必须重启MySQL服务. MySQL通过该参数确定启动时扫描哪些目录下的文件来恢复上下文.
- 上述目录对应的设备在MySQL服务运行期间不能被移除, 否则会导致MySQL抛出错误, 并且必须重启服务. 通常MySQL会保持该文件处于打开状态来防止设备被卸载, 但也可能在服务繁忙时短暂关闭. MySQL在启动时如果不能正确加载表指定目录中的文件, 启动过成将失败. 此时应当从备份中手动恢复该文件或从数据目录中将该表移除.
- 如果使用NFS, 需要阅读[官方文档](https://dev.mysql.com/doc/refman/8.0/en/disk-issues.html#disk-issues-nfs)中指出的一些额外注意事项.
- 如果使用如LVM或其他基于文件的备份策略, 在备份开始前应执行`FLUSH TABLES ... FOR EXPORT`来将内存中的更改刷写至磁盘.

在为每张表创建单独表空间的特性被关闭时, 也可以通过下述方式在外部目录中存储表数据, 达到与前文相同的效果:

```mysql
CREATE TABLE t(foo INT PRIMARY KEY) ENGINE=InnoDB DATA TABLESPACE=innodb_file_per_table DIRECTORY='/external/directory';
```

##### 行格式

InnoDB可以调整表的行格式, 默认为`DYNAMIC`. [动态](https://dev.mysql.com/doc/refman/8.0/en/glossary.html#glos_dynamic_row_format)和[压缩](https://dev.mysql.com/doc/refman/8.0/en/glossary.html#glos_compressed_row_format)行格式可以使InnoDB使用表压缩和长列页外存储的特性:

```mysql
# 只有使用独立表空间的表才能指定行格式
SET GLOBAL innodb_file_per_table=1;
# 动态
CREATE TABLE t_dynamic(foo INT PRIMARY KEY, bar CHAR(16)) ENGINE=InnoDB ROW_FORMAT=DYNAMIC;
# 压缩
CREATE TABLE t_compressed(foo INT PRIMARY KEY, bar CHAR(16)) ENGINE=InnoDB ROW_FORMAT=COMPRESSED;
```

也可以在特定表空间中创建表, 特定表空间支持所有的行格式, 也可以通过该语法在系统表空间中创建表.

```mysql
CREATE TABLE t(foo INT PRIMARY KEY, bar CHAR(16)) ENGINE=InnoDB TABLESPACE=innodb_system ROW_FORMAT=DYNAMIC;
```

##### 主键

InnoDB的表需要具有如下特性的列作为主键:

- 在最重要查询中被引用.
- 非空.
- 不重复.
- 插入后几乎不会修改.

在MySQL中由于聚簇索引特性, 主键的选择非常重要, 如果不是明确的知道应该如何选择主键, 可以在表中添加一个数字类型的自增列作为ID作为主键.

```mysql
CREATE TABLE t(id INT. AUTO_INCREMENT PRIMARY KEY, foo CHAR(32)) ENGINE=InnoDB;
```

尽管不指定主键的表也可以正常使用, 但主键对性能影响很大, MySQL文档建议在`CREATE TABLE ...`时就指定主键, 因为后续使用`ALTER TABLE`来指定主键的过程可能会消耗很长时间.

##### 显示表属性

通过下述语句来显示某张表的属性:

```mysql
SHOW TABLE STATUS FROM dev LIKE 't%' \G;
# *************************** 1. row ***************************
#            Name: t
#          Engine: InnoDB
#         Version: 10
#      Row_format: Dynamic
# ...

SELECT * FROM INFORMATION_SCHEMA.INNODB_TABLES WHERE NAME='dev/t' \G;
# *************************** 1. row ***************************
#      TABLE_ID: 1154
#          NAME: dev/t
#          FLAG: 33
#        N_COLS: 5
#         SPACE: 4
#    ROW_FORMAT: Dynamic
# ...
```

#### AUTO_INCREMENT

MySQL为带有`AUTO_INCREMENT`列的表进行数据插入时提供了可配置的锁机制. 不同配置下对于插入的并发度, 该列生成值得连续性有不同的影响. 具体细节可以查看官方文档的[相关页面](https://dev.mysql.com/doc/refman/8.0/en/innodb-auto-increment-handling.html), 此处不再展开.

### 索引(Indexes)

#### 聚簇索引和辅助索引

每张InnoDB表都有一个特殊的索引叫做聚簇索引(Clustered Index), 其中存储着行数据. 通常来说, 聚簇索引与主键同义. 为了提高查询和DML的效率, 必须理解InnoDB如何使用聚簇索引.

- 当使用`PRIMARY KEY`为表指定主键时, InnoDB将使用该列作为聚簇索引. 通常应当为所有的表定义主键, 如果没有合适的字段作为主键, 可以使用一个自增的数字列.
- 如果没有为表定义主键, MySQL会使用第一个唯一性非空索引作为聚簇索引.
- 如果以上两点都不符合, InnoDB将在内部生成一个名为GEN_CLUST_INDEX包含行ID的隐藏列. ID占用6-byte, 并在插入数据时自增, InnoDB按该列的顺序组织数据, 因此数据排序与插入顺序一致.

##### 聚簇索引如何加速查询

聚簇索引将索引记录和该行的数据存储在同一页中, 因此可以避免按索引查找后加载额外页的成本.

##### 辅助索引与聚簇索引的关系

所有非聚簇索引的索引被称为辅助索引. 在InnoDB中, 所有辅助索引中的记录包含该行数据对应的主键值, InnoDB继而通过该主键值级联查找聚簇索引从而获取行数据.

如果主键列很长, 则辅助索引需要更多的存储空间. 因此主键列的类型定义应当合适, 既满足范围需要, 又要避免占用过多空间.

#### 索引的物理结构

通常, InnoDB使用B+树作为索引的数据结构, 但也存在例外, 如空间索引则使用R树用于索引多维数据. 索引记录存储于B+树和R树的叶节点中. 默认页大小为16KB.

当向聚簇索引插入新记录时, InnoDB会尝试在页面中至少保留1/16的空间用于未来的插入操作. 如果插入的记录保持线性顺序(升序或降序), 那么最终会占用15/16, 如果以随机顺序插入, 则页面保留的空间从1/2到15/16不等.

当创建和重建B+树索引时, InnoDB使用批量加载而非依次插入单条记录的策略, 过程类似Tim Sort, 该方式也被称为有序索引构建. `innodb_fill_factor`变量定义了有序索引构建过程中页面空间占用的百分比, 当值为100时, InnoDB将保留1/16的页面空间用于未来新数据的插入. 有序索引构建不适用于空间索引. 关于有序索引构建的更多详细内容可以查看[官方文档](https://dev.mysql.com/doc/refman/8.0/en/sorted-index-builds.html).

当页面的装填因子低于`MERGE_THRESHOLD`这一阈值时, InnoDB会尝试收缩索引树并释放页面. 该阈值的默认值为50%. 这一配置对B+树和R树都有效.

索引页面大小可以通过`innodb_page_size`变量调整. 除非重新初始化MySQL实例, 否则该参数一旦设定就不可修改. 该值可被设定为64KB, 32KB, 16KB(默认), 8KB和4KB. 索引页面大小不同的实例之间无法复用数据和日志文件.

#### 全文索引

全文索引(FULLTEXT Index)是建立在文本列(CHAR, VARCHAR或TEXT)上, 用于加速基于该列数据的查询和DML操作的索引. 全文索引可以在创建表时指定, 或在后期通过`ALTER TABLE`语句添加.

MySQL内建的分词器支持中文. 全文索引可以通过`MATCH() ... AGAINST`语法来使用, 关于更多使用方法, 可以查看[官方文档](https://dev.mysql.com/doc/refman/8.0/en/fulltext-search.html).

##### 全文索引设计

InnoDB的全文索引实现方式为倒排索引, 即维护一个单词集合, 对于每个单词, 保存该单词出现的文档和相关位置信息.

##### 全文索引表

当建立带全文索引的表时, 将同时创建一系列表, 举例来说:

```mysql
CREATE TABLE web_pages(
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(256),
  content TEXT(1024),
  FULLTEXT ft_idx (content)
) ENGINE=InnoDB;

SELECT * FROM INFORMATION_SCHEMA.INNODB_TABLES WHERE name LIKE 'dev/%';

// +----------+---------------------------------------------------+-...-+
// | TABLE_ID | NAME                                              | ... |
// +----------+---------------------------------------------------+-...-+
// |     1155 | dev/web_pages                                     | ... |
// |     1156 | dev/fts_0000000000000483_being_deleted            | ... |
// |     1157 | dev/fts_0000000000000483_being_deleted_cache      | ... |
// |     1158 | dev/fts_0000000000000483_config                   | ... |
// |     1159 | dev/fts_0000000000000483_deleted                  | ... |
// |     1160 | dev/fts_0000000000000483_deleted_cache            | ... |
// |     1161 | dev/fts_0000000000000483_0000000000000117_index_1 | ... |
// |     1162 | dev/fts_0000000000000483_0000000000000117_index_2 | ... |
// |     1163 | dev/fts_0000000000000483_0000000000000117_index_3 | ... |
// |     1164 | dev/fts_0000000000000483_0000000000000117_index_4 | ... |
// |     1165 | dev/fts_0000000000000483_0000000000000117_index_5 | ... |
// |     1166 | dev/fts_0000000000000483_0000000000000117_index_6 | ... |
// +----------+---------------------------------------------------+-...-+
```

由index_1到index_6结尾的6张表存储了倒排索引, 称为辅助表或附属表. 当新插入的数据被分词之后, 每个独立的单词(或称为"令牌(token)")将被追加至倒排索引, 连带文档ID(DOC_ID)及其位置. 根据单词首字符在字符集中的权重排序和分区存储于这些表中. 将倒排索引拆分为6张表可以支持并行索引创建. 默认情况下, 有两个线程来完成分词, 排序和插入操作. 线程的数量可以进行配置控制, 在较大的表上添加全文索引时可以适当调高该参数以增加线程.

正如我们所见到的, 辅助表以fts\_为前缀并以index\_*为后缀. 辅助表通过名称中间的十六进制数字与索引表关联, 在前文所述的情况中, web_pages表的ID为1155, 16进制为483, 因此辅助表名称中包含"0000000000000483". 而后面的"0000000000000117"则为索引编号的十六进制, 117对应的十进制为279, 我们执行下述查询:

```mysql
SELECT index_id, name, table_id, space from INFORMATION_SCHEMA.INNODB_INDEXES WHERE index_id=279;
// +----------+--------+----------+-------+
// | index_id | name   | table_id | space |
// +----------+--------+----------+-------+
// |      279 | ft_idx |     1155 |     5 |
// +----------+--------+----------+-------+
```

即可得到该索引的信息.

如果启用了每张表单独表空间的特性, 则辅助表也将存储于该表空间中.

上述返回内容中的其他表为该表索引的公共信息, 存储全文索引的一些内部状态.

关于全文索引的更多细节可以查阅官方文档的[相关页面](https://dev.mysql.com/doc/refman/8.0/en/innodb-fulltext-index.html).

### 表空间(Tablespaces)

#### 系统表空间

**系统表空间**是用来存储双写缓冲区和Change Buffer的存储空间, 如果表没有被创建在单独的表空间或特定的表空间中时, 系统表空间也会存储这些表和其索引的数据. 在MySQL 8之前, 系统表空间还用来存储InnoDB数据字典, 而在MySQL 8之后, InnoDB将这些元数据存储于MySQL数据字典中.

系统表空间可以是一个或多个文件. 默认情况下, 是一个在数据目录中名为ibdata1的文件. 系统表空间文件的大小和数量调整, 以及使用原始磁盘分区作为系统表空间数据文件, 可以查看官方文档的[相关页面](https://dev.mysql.com/doc/refman/8.0/en/innodb-system-tablespace.html).

#### 单表文件表空间

**单表文件表空间**(File-Per-Table Tablespace)包含一张InnoDB表的数据及索引文件. 目前版本的InnoDB默认开启了此特性, 即每张InnoDB表使用自己的表空间, 在文件系统中表现为MySQL数据目录下的一个文件, 名为${表名}.ibd. 如前文提到的, 也可以通过`DATA DIRECTORY`来指定该文件的存储位置.

与共享文件表空间(如系统表空间或通用表空间)相比, 单表文件表空间具有以下优势:

- 当表被删除或清空(Truncate)时, 空间会被回收. 如果使用共享文件表空间, 在表被删除或清空后, 该空间可以被MySQL存放其他数据, 但不会归还给文件系统, 即共享表空间所占用的空间不会减小.
- 对共享表空间中的表进行`ALTER TABLE`时可能导致额外占用与其数据和索引空间相同的磁盘容量.
- `TRUNCATE TABLE`在单表文件表空间上性能更好.
- MySQL服务可以导入其他实例的单表文件表空间数据文件.
- 单表文件表支持`DYNAMIC`和`COMPRESSED`行格式, 系统表空间则不支持.
- MySQL企业备份可以快速备份和恢复使用个单表文件表空间创建的表.
- 单表文件表空间中的表可以通过监控文件系统中的数据文件大小来评估表数据容量.
- 当`innodb_flush_method`设置为`O_DIRECT`时, 文件写出受Linux文件系统单文件并发写入限制, 可能造成一定程度的性能损失.
- 共享表空间受单表空间总容量64TB的限制.

单表文件表空间具有以下缺陷:

- 待回收空间无法被多表复用.
- 对多表的写操作会导致多个`fsync`调用.
- mysqld进程必须保持所有表文件打开状态, 同时占用多个文件描述符, 当表数量较多时会降低性能.
- 需要进行碎片管理, 否则会有较为严重的碎片化问题.
- 删除表会导致对Buffer Pool的扫描, 该操作占用内部锁, 有可能导致其他操作被延时.
- `innodb_autoextend_increment`变量失效, 将使用4MB作为扩展大小.

#### 通用表空间

**通用表空间**(General Tablespace)是InnoDB通过`CREATE TABLESPACE`语法创建的共享表空间. 通用表空间提供一下特性:

- 与系统表空间类似, 通用表空间属于共享表空间, 因此可以存储多张表的数据及其索引.
- 相较于单表文件表空间, 通用表空间在内存占用上具有潜在优势. 由于InnoDB会将表空间元数据常驻于内存, 因此多表复用通用表空间时可以节省出表空间元数据内存.
- 通用表空间可以将其数据文件置于MySQL数据目录之外, 从而具备更有效的磁盘管理能力.
- 通用表空间支持所有行格式及相关特性.

可以在`CREATE TABLE`和`ALTER TABLE`时使用`TABLESPACE`选项指定表空间或将表移动至指定表空间. 

通用表空间存在以下限制:

- 已存在的其他表空间无法转换为通用表空间.
- 无法创建临时通用表空间, 临时表不支持通用表空间.
- 与系统表空间类似, 删除或清空表不会释放相应的磁盘空间, `ALTER TABLE`也会造成额外的空间占用.
- 通用表空间中的表不支持`ALTER TABLE ... DISCARD TABLESPACE`和`ALTER TABLE ... IMPORT TABLESPACE`.
- MySQL 8移除了对将表分区存储至通用表空间的支持.

关于通用表空间的创建和更多详细特性, 可以查看官方文档的[相关页面](https://dev.mysql.com/doc/refman/8.0/en/general-tablespaces.html).

#### 撤销表空间

**撤销表空间**中包含记录聚簇索引历史版本信息的撤销日志. 撤销日志位于撤销日志段中, 撤销日志段位于回滚段中. 变量`innodb_roback_segements`定义了每个撤销表空间中回滚段的数量.

MySQL实例初始化时会创建两个默认撤销表空间来提供回滚段. 回滚段必须在任何SQL语句执行前存在. 至少需要两个撤销表空间才支持撤销表空间的自动截断, 有关自动截断的特性, [官方文档](https://dev.mysql.com/doc/refman/8.0/en/innodb-undo-tablespaces.html#truncate-undo-tablespace)中有较为详尽的描述.

撤销表空间默认创建在变量`innodb_undo_directory`指定的目录下, 如果该变量未定义, 则为MySQL数据目录. 文件名默认为undo_001和undo_002. 数据字典中的名称定义为innodb_undo_001和innodb_undo_002.

撤销表空间的起始大小受变量`innodb_page_size`的影响, 当其保持默认值16KB时, 撤销表空间为10MiB. 当该变量值为4KB, 8KB, 32KB和64KB时, 对应的撤销表空间起始大小分别为7MiB, 8MiB, 20MiB和40MiB.

撤销表空间的添加, 删除, 移动, 清空和回滚段数量配置的具体步骤可以查看官方文档的[相关页面](https://dev.mysql.com/doc/refman/8.0/en/innodb-undo-tablespaces.html).

#### 临时表空间

InnoDB使用会话临时表空间和全局临时表空间.

##### 会话临时表空间

当InnoDB被配置为用户和内部优化器创建的临时表的存储引擎时, **会话临时表空间**将用于存放对应的数据. 目前版本的MySQL总是使用InnoDB作为临时表的存储引擎, 但在老版本中则受变量`internal_tmp_disk_storage_engine`控制.

InnoDB在处理会话中首个需要创建磁盘临时表的请求时, 会从临时表空间池中申请一段空间. 每个会话最多申请两个临时表空间, 一个用于用户创建临时表, 另一个用于内部优化器创建临时表. 会话创建的所有磁盘临时表都将使用申请到的会话临时表空间. 当会话连接断开时, 其申请的会话临时表空间将被清空和释放, 归还至临时表空间池. 当MySQL服务启动时, 临时表空间池中存在10个临时表空间, 当该池不能满足需要时会被自动扩展, 但在冗余时不会自动收缩. 当服务停止或初始化失败时, 临时表空间池会被移除. 会话临时表空间文件在创建时为5个页面大小, 同时以.ibt作为文件扩展名.

系统保留了40万个临时表空间ID, 并且由于重启将清空临时表空间并重建, 因此ID可被复用. 变量`innodb_temp_tablespaces_dir`定义了会话临时表空间创建的位置, 默认位置为MySQL数据文目录中的`#innodb_temp`子目录. 如果临时表空间池创建失败, 启动将被中断.

在基于语句的复制集(Statement Based Replication, SBR)模式中, 在从节点上临时表只会在一个临时表空间中创建.

##### 全局临时表空间

**全局临时表空间**存储用户创建临时表的回滚段. 变量`innodb_temp_data_file_path`定义了全局临时表空间数据文件的相对路径, 名称, 大小, 自动扩展和限制等属性, 如果该变量为空, InnoDB的默认行为为创建一个自动扩展的, 位于数据目录下的名为ibtmpl的文件, 初始大小约为12MB.

与会话临时表空间类似, 全局临时表空间的数据文件将在服务停止或初始化失败时被清理. 全局临时表空间在创建时使用动态生成的ID, 如果创建失败, 启动将被中断. 如果服务意外终止, 全局临时表空间不会被清理, 此时可以重启服务或手动移除该文件, 重启服务会删除并重新创建全局临时表空间.

尽管系统表空间可以使用原始磁盘分区, 但全局临时表空间不能存在于原始磁盘分区上.

#### 服务离线时移动表空间

MySQL的`innodb_directories`启动选项定义了服务启动时扫描表空间文件的目录. 当服务离线时, 这些文件的位置可以被移动, 但需要保证移动后的对服务可见, 即包含于该选项之中. 服务启动过程中, MySQL会使用在目录中发现的表空间文件, 而不是数据字典中引用的文件, 同时数据字典中的引用也会更新. 如果扫描过程中发现了表空间ID重复的文件, 启动将会抛出错误.

变量`innodb_data_home_dir`, `innodb_undo_directory`和`datadir`会被自动添加至`innodb_directories`. 也就是说即使不显式配置该变量这些变量对应的目录也会被扫描. 因此在这些目录中移动文件无需修改`innodb_directories`, 但对应变量必须在重启前更新.

`innodb_directories`即可作为启动参数, 也可写入配置文件:

```ini
# For Commandline
mysqld --innodb-directories="directory_path_1;directory_path_2"

# For Configuration
[mysqld]
innodb_directories="directory_path_1;directory_path_2"
```

### 双写缓冲区(Doublewrite Buffer)

**双写缓冲区**是InnoDB在将Buffer Pool内的内容写到磁盘正确位置前, 在系统表空间中用于预写的存储空间. 只有在指定页刷写至双写缓冲区之后, InnoDB才会在真正的位置写出该页. 如果在后者过程中出现了操作系统, 文件系统或MySQL服务错误导致服务崩溃, InnoDB仍然可以从双写缓冲区中找到正确的备份页面.

尽管数据被写了两次, 引入双写缓冲区并不需要两倍的I/O负载, 因为双写缓冲区的写入操作是连续批量的, 在实现中表现为仅一次`fysnc`调用.

在绝大多数场景中双写缓冲区被默认启用. 如果需要禁用, 可以将变量`innodb_doublewrite`置为0.

如果系统表空间位于支持原子性操作的[Fusion-io](https://en.wikipedia.org/wiki/Fusion-io)设备上, 双写缓冲区特性将被自动禁用, 同时对数据的所有写操作将使用Fusion-io的原子性写操作. 由于是否启用双写缓冲区为全局设置, 因此即使某一张表的表空间文件不在Fusion-io设备上, 也不会使用双写缓冲区. 如果需要利用这一特性, 建议将`innodb_flush_method`变量置为`O_DIRECT`;

### 重做日志(Redo Log)

**重做日志**是用于故障后从未完成的事务状态下恢复数据时使用的磁盘数据结构. 在正常操作期间, 重做日志对由SQL语句或低级API调用引起的页面数据修改请求编码为逻辑物理日志. 在服务初始化, 接受连接之前, MySQL将自动重放之前因故障导致的未完成的页面数据修改.

对于具有MVCC特性的数据库, 其故障恢复流程大致:

1. 根据重做日志, 恢复数据页和撤销页至故障前的状态.
2. 根据撤销页的内容(历史版本数据), 回滚没有提交的事务.

由于MySQL最小I/O单位为页面, 默认为16KB, 文件系统最小I/O单位通常小于这个值, 如4K或1K, 磁盘I/O单位则更小, 因此, 磁盘刷写过程可能出现脏写导致页断裂(Partial Page Write)的问题, 举例来说, 一个16KB页面写出期间, 在写出4K后因意外导致服务器掉电, 就会造成在磁盘上出现损坏的页. 

数据库日志实现主要分为3种:

- **逻辑日志**(Logical Logging): <插入, 表1, <1, 2, 3>>
- **逻辑物理日志**(Physiological Logging): <插入, 页面1, 日志体>. 如果表1有辅助索引, 则插入操作至少涉及2个页面, 因此实际会产生2条逻辑物理日志.
- **物理日志**(Physical Logging): <组1, 文件1, 页面1, 偏移量1, 1(值)>. 插入操作对单页而言涉及页头, 链表指针等多个属性的修改, 假设每个页面的改动需要记录N条物理日志, 则在至少涉及2个页面的插入操作中需要2N条物理日志.

不同种类的日志所需空间和信息完整度各不相同. 物理日志的信息最完整, 不依赖页面原始状态, 并且是幂等的, 但完整记录物理日志需要占用大量空间. 如果MySQL的重做日志使用物理日志格式, 则根据重做日志进行故障恢复不会受页断裂问题的影响. 而MySQL使用的是逻辑物理日志, 因此依赖于页面处于一致状态, 如果发生页断裂, 故障恢复将遇到问题. 此时, MySQL就需要前文提到的双写缓冲区来恢复该页面. [这篇](https://www.cnblogs.com/geaozhang/p/7241744.html)和[这篇](https://www.cnblogs.com/cchust/p/3961260.html)博文更加详细的介绍了这种情况.

在官方文档的[InnoDB故障恢复](https://dev.mysql.com/doc/refman/8.0/en/innodb-recovery.html)页面详细介绍了重做日志在故障恢复中起到的作用.

默认情况下, 重做日志在磁盘上表现为名为ib_logfile0和ib_logfile1的两个文件. MySQL以轮转的方式写出重做日志. 重做日志中的数据由受影响的行记录编码, 通过重做日志的数据会以不断增加的LSN(Log Sequence Number)值表示.

InnoDB与其他支持ACID的数据库引擎一样, 在事务提交前会先将重做日志刷盘. InnoDB通过组提交(Group Commit)的方式, 将多个事务的重做日志同时刷盘, 减小I/O开销.

[官方文档](https://dev.mysql.com/doc/refman/8.0/en/innodb-redo-log.html)中对重做日志的配置和备份有详细的说明, 这里不做讨论.

### 撤销日志(Undo Log)

**撤销日志**是一组关联到某个读写事务的**撤销日志记录**(Undo Log Record)集合, 每条撤销日志记录包含如何撤销该事务最近一次对聚簇索引记录的修改. 当其他事物需要该记录的历史版本来进行一致性非锁定读时, 指定撤销日志中的数据将作为结果返回. 撤销日志存储于全局临时表空间和撤销表空间中的回滚段中的撤销日志段中.

修改用户定义临时表数据的事务将使用全局临时表空间中的回滚日志. 由于这些表仅用于事务回滚, 不需要被故障恢复, 因此不会被记录重做日志, 从而降低了I/O负载.

每个撤销表空间和全局临时表空间支持最多128个回滚段, 可以通过变量`innodb_rollback_segments`来调整. 每个回滚段支持的事务数量依赖于回滚段内的插槽(Slot)数量和事务所需的撤销日志数量. 回滚段内的插槽数量又与页面大小有关.

每个事务可分配4个撤销日志, 以下类型每种可分配一个:

1. 在用户定义表上进行`INSERT`.
2. 在用户定义表上进行`UPDATE`和`DELETE`.
3. 在用户定义临时表上`INSERT`.
4. 在用户定义临时表上`UPDATE`和`DELETE`.

这些类型会被按需分配, 举个例子, 如果一个事务在常规和临时表上进行了`INSERT`, `UPDATE`和`DELETE`操作, 那么他需要全部共4个撤销日志; 如果一个事务只在常规表上执行了`INSERT`, 那它只需要1个撤销日志. 分配给事务的撤销日志在其存在过程中始终为该事务所用.

操作常规表所产生的撤销日志位于表空间回滚段, 操作临时表所产生撤销日志位于全局临时表空间回滚段.

当回滚段中的插槽耗尽时, InnoDB会抛出事务并发数量限制的相关错误. 结合之前的论述, 我们可以通过事务内触发的操作, 撤销表空间的数量及其包含的回滚段的个数大致估算InnoDB支持的并发读写事务数量.
