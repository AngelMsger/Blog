---
title: InnoDB锁和事务
date: 2020-03-05 13:54:16
tags:
- MySQL
- InnoDB
- Database
- DevOps
- Optimization
categories:
- Database
thumbnail: "/images/banner/InnoDB锁和事务.png"
typora-root-url: ../../source/
---

本文研究InnoDB锁和事务逻辑.

# 锁

## 共享锁和排他锁

InnoDB实现了标准的行级共享锁(Shard Lock)和排他锁(Exclusive Lock):

- 共享锁(S)允许得到锁的事务对行进行读操作.
- 排他锁(X)允许得到锁的事务进行写操作. 

我们可以很容易的根据两种锁的名字推测出他们的性质和应用场景. 举例来说, 如果事务T1得到了某一行的共享锁, 那么对于另一事务T2:

- 可以立即取得该行的共享锁, 成功后T1和T2共同持有该行的共享锁.
- 不能立即取得该行的排他锁.

相反, 如果事务T1得到了某一行的排他锁, 那么对于另一事务T2, 无论该行的共享锁还是排他锁都不能立即取得.

## 意向锁

InnoDB支持多粒度锁(Multiple Granularity Locking), 即同时存在表级锁和行级锁. 举例来说, 如`LOCK TABLES ... WRITE;`将在特定表上加上排他锁. 假设没有意向锁, 举例来说, InnoDB为了判断能否在特定表上加表级排他锁, 需要扫描所有行并确定所有行上都不存在行级共享锁和排他锁, 这显然会对性能产生很大影响. 为了在实现多粒度锁的同时避免这种情况, InnoDB引入了意向锁机制. 意向锁是一种表级锁, 表示有事务将在之后在该表上申请对应类型的行级锁. 因此也就存在两种类型的意向锁:

- 意向共享锁(Intention Shard Lock, IS)表示事务需要在表中的某些行上申请共享锁.
- 意向排他锁(Intention Exclusive Lock, IX)表示有事务将在表中的某些行上申请排他锁.

举例来说, `SELECT ... FOR SHARE;`在指定表上加意向共享锁, `SELECT ... FOR UPDATE;`在指定表上加意向排他锁. 意向锁的行为如下:

- 在事务可以取得该表的行级共享锁之前, 他必须能够取得该表的意向共享锁或更严格的锁.
- 在事务可以取得该表的行级排他锁之前, 他必须能够取得该表的意向排他锁.

对于表级锁, 锁类型和兼容性如下表:

|      | `X`      | `IX`           | `S`        | `IS`           |
| ---- | -------- | -------------- | ---------- | -------------- |
| `X`  | Conflict | Conflict       | Conflict   | Conflict       |
| `IX` | Conflict | **Compatible** | Conflict   | **Compatible** |
| `S`  | Conflict | Conflict       | Compatible | Compatible     |
| `IS` | Conflict | **Compatible** | Compatible | **Compatible** |

请注意上表中的加粗部分, 表级的意向锁彼此是兼容的, 因为允许不同事务对表内不同行分别加读锁和写锁.

## 记录锁(行级锁)

记录锁(Record Lock)是加在索引记录上的锁. 举例来说, `SELECT c1 FROM t WHERE c1 = 10 FOR UPDATE;`会阻止其他事务插入,更新或删除t.c1 = 10的行. 即使在表上没有建立索引, 记录锁的逻辑也会执行, 在这种场景下, InnoDB将建立隐式的聚簇索引.

## 间隙锁

间隙锁(Gap Lock)是加在索引记录之间(或首末)的锁. 举例来说, `SELECT c1 FROM t WHERE c1 BETWEEN 10 and 20 FOR UPDATE;`会阻止其他事务插入t.c1 = 15的行, 无论这样的行是否存在于该查询的结果集中, 因为在索引中范围内所有的间隙都被锁定了.

间隙锁唯一的意义就是防止事务在该间隙内插入行, 因此多个事务可以同时持有相同同一间隙位置的间隙锁, 即他们都声明不能在当前间隙插入记录. 间隙锁只会出现在非唯一索引上, 举例来说, `SELECT * FROM child WHERE id = 100;`这个查询, 在id列上的索引不是唯一索引时才会在child.id=100前的间隙上加上间隙锁, 否则不会.

间隙锁是性能和并发性的一种权衡, 只会在某些事务隔离级别中被启用. 如果你希望禁用这一特性, 则可将事务的隔离级别调整为READ_COMMITTED.

## 临键锁

临键锁(Next-Key Lock)是记录锁和记录前间隙上的间隙锁的合并. InnoDB的行级锁实现是在查找或扫描某些行的过程中在其索引上添加记录锁, 因此行级锁实际上就是记录锁. 而临键锁在锁定索引记录的同时还会锁定记录前的间隙. 因此, 如果一个会话持有记录R的临键锁, 另一个会话就无法在R前的间隙内插入新的记录.

举例来说, 假设索引中存在记录10, 11, 13和20. 那么临键锁可能涵盖的范围如下:

(-∞, 10], (10, 11], (11, 13], (13, 20], (20, +∞)

默认情况下, InnoDB的事务隔离级别为REPEATABLE_READ, 在这种级别下, InnoDB在查找和扫描索引的过程中会使用临键锁, 从而防止幻读.

## 插入意向锁

插入意向锁是InnoDB在某一间隙上插入记录前在该间隙中加的锁. 由于间隙锁的意义就是防止在间隙范围内插入, 因此插入意向锁与间隙锁必然是不兼容的. 插入意向锁本身的意义是让多个事务在同一个间隙内的插入操作, 在实际位置不冲突的情况下并发的执行. 举例来说, 假设索引内存在记录4和7, 两个独立事务分别意图插入5和6, 那么两个事务能各自在同一间隙中取得记录5和6的插入意向锁而不产生冲突. 举例来说:

```mysql
# In Session A:
CREATE TABLE foo(id INT PRIMARY KEY) ENGINE=InnoDB;
INSERT INTO foo(id) values (90), (102);
START TRANSACTION;
SELECT * FROM foo WHERE id > 100 FOR UPDATE;
# 102 前的间隙上会存在间隙锁

# In Session B:
START TRANSACTION;
INSERT INTO foo(id) VALUES (101);
# 尝试在 (90, 102) 区间内加插入意向锁, 但该区间上已有间隙锁, 操作将被阻塞
```

## 自增锁

自增锁(Auto-Inc Lock)是事务在存在AUTO_INCREMENT列的表中进行插入时可能会使用的表级锁. 举例来说, 当事务T1在表中插入数据时, 事务T2在插入数据前必须等待T1释放自增锁, 以保证T1插入的数据自增列的值连续. InnoDB现在也通过修改`innodb_autoinc_lock_mode`配置以牺牲自增列值得连续性为代价来提升插入的并发度.

# 事务模型

InnoDB的事务模型结合了多版本控制和二阶段锁. 默认情况下InnoDB使用行级锁并以非阻塞一致性读的方式执行查询. InnoDB的锁信息存储结构非常高效, 在绝大多数场景中能够在不导致内存耗尽的条件下允许多个用户对表中的所有行或任意子集进行锁定.

## 隔离级别

事务的隔离性(Isolation)是数据库的基础能力之一, 也就是ACID中的I. 事务的隔离级别是在多个事务同时操作时, 将可靠性, 一致性和可重现性与性能进行权衡下的不同配置. InnoDB支持SQL标准中全部4个事务隔离级别(从宽松至严格): 

- READ_UNCOMMITTED
- READ_COMMITTED
- REPEATABLE_READ
- SERIALIZABLE

默认情况下为REPEATABLE_READ. 用户可以根据数据和场景的特征为每个会话设置独立的事务隔离级别, 也可以通过配置文件或运行参数调整实例的全局默认设置.

InnoDB通过使用不同的锁策略来实现不同的隔离级别. 下面从使用频率由高至低展开介绍这4种隔离级别的实现方式.

### REPEATABLE_READ

InnoDB事务的默认隔离级别. 同一事务中的多次一致性读都会读取首次读取时产生的快照, 因此得到的结果必然是一致的. 更多细节可以阅读后文讨论的一致性非锁定读.

对于锁定读(带有`FOR UPDATE`或`FOR SHARE`的SELECT语句), 更新和删除语句, 锁策略取决于查询条件是否是基于唯一索引的确定查询:

- 对于使用唯一索引的确定查询, InnoDB只在该索引记录上加记录锁, 而不会在其前面的间隙上加间隙锁.
- 对于其他情况, InnoDB将在扫描范围的索引范围内加间隙锁或临键锁以防止其他事务在这些位置进行插入.

### READ_COMMITTED

同一事务多次一致性读, 每次读取都会产生新的快照.

对于锁定读, 更新和删除语句, InnoDB只会在相应的索引记录上加记录锁, 而不会在他们前面的间隙上加间隙锁, 因此允许其他事务在这些锁定记录间的间隙插入新记录. 间隙锁只在外键和重复性检查时使用.

由于没有使用间隙锁, 因此可能会出现幻读.

READ_COMMITTED必须与基于行的Bin Log配置同时使用.

使用READ_COMMITTED隔离级别还将产生以下额外影响:

- 对于更新和删除语句, InnoDB只会持有对应行记录的记录锁, 降低了死锁产生的频率.
- 对于更新语句, 如果该行已经被锁定, InnoDB将执行半一致性读, 返回最后已提交版本来决定是否与过滤条件匹配, 如果匹配, InnoDB才会去尝试竞争该锁.

举例来说:

```mysql
CREATE TABLE foo(x INT NOT NULL, y INT) ENGINE=InnoDB;
INSERT INTO foo VALUES (1, 2), (2, 3), (3, 2), (4, 3), (5, 2);
COMMIT;

# In Session A:
START TRANSACTION;
UPDATE foo SET y = 5 WHERE y = 3;

# In Session B:
START TRANSACTION;
UPDATE foo SET y = 4 WHERE y = 2;
```

由于该表没有索引, InnoDB 后续将使用隐式的索引来创建记录锁.

在接收更新语句后, InnoDB会尝试在该表的每一行上加排他锁, 然后决定是否需要更新它. 如果没有命中过滤条件, 则立即释放该记录上的锁, 否则锁将在事务提交后释放.

当使用REPEATABLE_READ时, 会话一中的更新语句将获取他扫描到的所有记录的排他锁并持续到事务结束:

```mysql
# 锁定(1, 2); 保留锁.
# 锁定(2, 3); 将(2, 3)更新为(2, 5); 保留锁.
# 锁定(3, 2); 保留锁.
# 锁定(4, 3); 将(4, 3)更新为(4, 5); 保留锁.
# 锁定(5, 2); 保留锁.
```

由于会话一中的更新语句取得了所有行的锁, 第二条更新语句必须等到等到会话一中的事务结束后才能执行. 而如果使用READ_COMMITTED, 会话一中的语句执行时首先会取得每一行的锁, 并在确认无需对其修改后释放该锁:

```mysql
# 锁定(1, 2); 释放锁.
# 锁定(2, 3); 将(2, 3)更新为(2, 5); 保留锁.
# 锁定(3, 2); 释放锁.
# 锁定(4, 3); 将(4, 3)更新为(4, 5); 保留锁.
# 锁定(5, 2); 释放锁.
```

InnoDB会对会话二中的更新语句执行半一致性读, 即返回最后提交版本的记录来判断是否需要对其进行修改:

```mysql
# 锁定(1, 2); 将(1, 2)更新为(1, 4); 保留锁.
# 锁定(2, 3); 释放锁.
# 锁定(3, 2); 将(3, 2)更新为(3, 4); 保留锁.
# 锁定(4, 3); 释放锁;
# 锁定(5, 2); 将(5, 2)更新为(5, 4); 保留锁.
```

然而, 如果WHERE后的过滤条件可以命中某个索引, InnoDB将使用该索引, 并且锁策略只会基于该索隐列, 而不是像上述例子中的全部记录.

### READ_UNCOMMITTED

`SELECT`语句会在一个可能是较早的版本上以非锁定的方式执行. 因此这种隔离级别并不能保证一致性, 有可能产生脏读.

### SERIALIZABLE

这种隔离级别与REPEATABLE_READ类似, 但在自动提交被禁用时InnoDB会将所有`SELECT`隐式转换为`SELECT ... FOR SHARE`. 在自动提交启用时, 每个`SELECT`是一个独立的事务, 并且由于该事务对数据是只读的, 因此会按一致性读处理.

## 提交和回滚

在InnoDB中, 所有的用户活动都发生在事务内. 如果自动提交被启用, 每个SQL语句都被包裹在独立的事务内. 默认情况下, MySQL连接的所有会话的自动提交都是被启用的, 因此MySQL会在每个语句执行成功后提交, 执行失败后回滚.

当自动提交启用时, 可以通过显式的`START TRANSACTION`或`BEGIN`来开启一个多语句事务.

当使用`SET autocommit = 0;`来禁用掉自动提交特性时, 每个会话始终会持有一个打开的事务, 当使用`COMMIT`提交时, 会结束当前事务并开启一个新的事务.

如果会话结束但事务没有提交, 则会被回滚, 如果使用了[包括DDL在内的语句](https://dev.mysql.com/doc/refman/8.0/en/implicit-commit.html), 也会导致MySQL隐式提交当前事务. 事务的提交会让当前事务的修改在其他会话内可见, 事物的回滚则会取消掉当前事务内的修改. 提交和回滚都会释放事务内持有的全部锁.

## 一致性非锁定读

一致性读是指InnoDB通过维护多版本数据来使查询基于数据库在某一时间点的快照. 查询可以看到所有查询时间前已提交的数据, 但不包含查询时间之后提交或之前被其他事务修改但未提交的数据. 但同一事务内之前的修改会被之后的查询看到. 这一行为造成了一种异常的现象, 即修改后看到了该行的最新版本, 同时和其他行的老版本. 如果存在其他事务修改了该行的数据, 则会使查询看到一个数据库中并不存在过的快照.

如果事务的隔离级别是REPEATABLE_READ(默认设置), 所有事务内的一致性读将会读取首次查询触发建立的快照版本. 可以通过提交当前事务并在新事务中查询来获取更新的快照.

如果事务的隔离级别是READ_COMMITTED, 每次一致性读都会使用全新的快照.

在REPEATABLE_READ和READ_COMMITTED隔离模式中, 一致性读是InnoDB处理`SELECT`语句的默认模式. 一致性读不会在表和扫过的行上设置任何锁, 也因此不会影响其他事务同时读写表中的数据.

在默认的REPEATABLE_READ隔离模式下, 当你触发一致性读时, InnoDB会根据查询时间返回一个快照版本, 如果在该时间后有其他事务删除了某些行并提交, 在当前事务的一致性读过程也不会看到折哟删除导致的影响. 插入和更新也是类似.

一致性读只适用于`SELECT`语句而不包括DML. 也就是说, 如果插入或修改一些行随后提交当前事务, 另一REPEATABLE_READ级别的并发事务中的语句可能会影响这些行, 即使该事务的之前的一致性读并未看到这些行. 如果事务的更新或删除影响到了其他事务已提交的行, 比如刚才这个场景, 那么这些行将在当前事务随后的操作中变得可见. 举例来说:

```mysql
SELECT COUNT(c_1) FROM foo WHERE c_1 = 'spectre';
# Return 0.
DELETE FROM foo WHERE c_1 = 'spectre';
# 将删除一些被其他事务已提交并命中当前条件的行.

SELECT COUNT(c_2) FROM foo WHERE c_2 = 'nevermore';
# Return 0.
UPDATE foo SET c_2 = 'puck' WHERE c_2 = 'nevermore';
# 更新了 10 行由其他事物刚刚提交的记录.
SELECT COUNT(c_2) FROM foo WHERE c_2 = 'puck';
# Return 10.
```

可以通过提交当前事务并在新在新的事务中进行查询来取得更新的状态.

```mysql
# In Session A:						In Session B:
SET autocommit = 0;		SET autocommit = 0;
SELECT * FROM foo;
-- empty set
											INSERT INTO foo VALUES (1, 2);
SELECT * FROM foo;
-- empty set
											COMMIT;
SELECT * FROM foo;
-- empty set
COMMIT;
SELECT * FROM foo;
-- (1, 2)
```

这种方式被称为多版本并发控制(Multi-Version Concurrency Control, MVCC). 如果总是希望看到数据库最新的一致性状态, 可以将事务的隔离级别设置为READ_COMMITTED, 或使用有锁读(Locking Read):

```mysql
SELECT * FROM foo FOR SHARE;
```

当使用READ_COMMITTED隔离级别时, 事务内的每次一致性读都将建立全新的快照. 当使用`FOR SHARE`时会执行有锁读, 因此会阻塞直到事务在命中行上取到锁并读取最新状态. 更多细节可以阅读后文的锁定读章节.

以下DDL会使一致性读失效:

- `DORP TABLE`, 因为InnoDB会销毁该表关联的对象.
- `ALTER TABLE`, 因为这一语句会使InnoDB为表创建临时副本并删除原表. 新表中的数据在一致性读中全部不可见, 在这种情况下, InnoDB会抛出表定义已修改的相关错误.

如果在语句`INSERT INTO ... SELECT`, `UPDATE ... (SELECT)`和`CREATE TABLE ... SELECT`中没有指定`FOR UPDATE`或`FOR SHARE`:

- 默认情况下, 会执行与READ_COMMITTED隔离模式下一直的一致性读.
- 在SERIALIZABLE隔离模式下不会使用一致性读.

## 锁定读

如前文所述, 即使在同一事务内, 先查找后基于查找结果进行修改的场景中普通的`SELECT`也不能提供足够的保护. 因为这种一致性非锁定读不会阻止其他事务对这些行进行更新和删除. InnoDB提供两种锁定读来保证安全性.

```mysql
SELECT ... FOR SHARE;
```

在读取的行上加上共享锁, 在当前事务提交前, 其他会话可以读取这些行, 但不能修改他们. 如果在当前事务读之前有其他事务修改了这些行但没有提交, 当前行的查询会阻塞直到该事务提交或回滚, 然后读取最新的值.

```mysql
SELECT ... FOR UPDATE;
```

在读取行及相关索引上加上排他锁, 就好像执行了UPDATE语句一样. 其他事务的更新操作和`SELECT ... FOR SHARE`会被阻塞, 但一致性读不会受此影响(老版本数据不能被加锁).

在处理树结构或图结构的数据时, 无论数据分布于单表还是多表中, 对于树分支或图边遍历, 指针更新这样的场景, 上述语句都很有意义.

上述语句产生的锁都会随着事务的提交或回滚而释放.

锁定读只在自动提交被禁用时有效.

除非在子查询中显式指明锁定读, 否则外部查询的锁定读不会作用于嵌套的子查询. 举例来说, 下述语句不会在表bar上加锁:

```mysql
SELECT * FROM foo WHERE c_1 = (SELECT c_1 FROM bar) FOR UPDATE;
```

如果要在bar上加锁, 需要在子查询中显式指明:

```mysql
SELECT * FROM foo WHERE c_1 = (SELECT c_1 FROM bar FOR UPDATE) FOR UPDATE;
```

### 场景示例

假设现在业务逻辑需要向表child中插入记录, 并保证child中的记录必然在parent中有关联记录.

```mysql
SELECT COUNT(id) FROM parent WHERE id=1;
// If Exists
INSERT INTO child(name, parent) VALUES ("子节点", 1);
```

上述语句安全的吗? 不安全, 因为一致性读不会在原表上加锁, 其他会话中的事务可能会在`SELECT`后`INSERT`前将id为1的parent记录删除. 为了避免这种情况, 应将一致性读调整为锁定读:

```mysql
SELECT COUNT(id) FROM parent WHERE id=1 FOR SHARE;
```

在此查询返回结果为1时, 可以在表child中插入记录并保证数据的一致性, 在当前事务结束之前, 其他事务都无法取到该记录上的排他锁.

再举一例, 假设我们在表child_codes中手动维护一个自增id来作为child表中最新记录的id, 和之前的例子类似, 使用一致性读并不能保证生成安全的id, 那么像之前一样使用`FOR SHARE`可以吗? 也是不行的, 因为并发的事务将看到同样的id值, 最终破坏插入数据的一致性, 并且在两个事务都执行`UPDATE`时将导致死锁. 为了实现这样的读并更新逻辑, 应该使用`ROR UPDATE`, 在读取的记录上加上排他锁, 然后执行更新:

```mysql
SELECT counter_field FROM child_codes FOR UPDATE;
UPDATE child_codes SET counter_field = counter_field + 1;
```

排他锁将阻止其他事务读取和更新该值. 这个例子只是用来演示`FOR UPDATE`的作用, 如果只是维护最大的ID, 可以只读写该表一次: 

```mysql
UPDATE child_codes SET counter_field = counter_field + 1;
SELECT LAST_INSERT_ID();
```

`SELECT`只会读取当前连接的标识符信息, 不会执行表查询.

### NOWAIT和SKIP LOCKED

如果表中的一行记录被一个事务加了排他锁, 其他以锁定读的方式查询该行的事务都将阻塞直到锁被释放, 从而阻止这些事务修改或删除该行. 如果在查询时希望跳过所有被锁定的行, 从而使请求立即返回或得到一个排除锁定行的结果集, 可以在`SELECT ... FOR SHARE`和`SELECT ... FOR UPDATE`时使用`NOWAIT`和`SKIP LOCKED`.

- `NOWAIT`: 查询不会阻塞, 如果遇到锁冲突则立即抛出错误.
- `SKIP LOCKED`: 查询不会阻塞, 如果遇到锁冲突则从结果集中排除该行.

由于`SKIP LOCKED`返回的视图是不一致的,  因此不应在通常的业务中使用. 但在某些场景中, 如并发访问用作队列的表数据, 则能提升性能. 出于同样的原因, `NOWAIT`和`SKIP LOCKED`对基于语句的复制集是不安全的.

举例来说:

```mysql
# In Session 1:
CREATE TABLE baz(num INT PRIMARY KEY) ENGINE = InnoDB;
INSERT INTO baz(num) VALUES (1), (2), (3);
START TRANSACTION;
SELECT num FROM baz WHERE num = 2 FOR UPDATE;
# +---+
# | i |
# +---+
# | 2 |
# +---+

# In Session 2:
START TRANSACTION;
SELECT num FROM baz WHERE num = 2 FOR UPDATE NOWAIT;
# Error(3572) ...

# In Session 3:
START TRANSACTION;
SELECT num FROM baz WHERE num = 2 FOR UPDATE SKIP LOCKED;
# +---+
# | i |
# +---+
# | 1 |
# | 3 |
# +---+
```

# 事务与锁的关系

无论是否精确命中`WHERE`过滤条件, 锁定读, 更新或删除都会在语句执行时在扫描过的索引记录上加锁. InnoDB不会记录`WHERE`条件, 只会记录索引范围. 加锁的类型通常是临键锁, 因此锁定记录的同时还将阻止其他事务在记录前的间隙中插入数据. 正如前文已提到的, 当间隙锁被显示禁用时不会使用临键锁, 同事事务隔离级别也将影响锁的类型.

如果扫描过程中使用的是辅助索引, 那么InnoDB会在聚簇索引中在相应记录上也加锁.

如果查询没有命中索引, 即MySQL必须扫描整个表来返回执行结果, 那么每一行都将被锁定, 继而阻止其他所有事务在表中插入数据. 因此, 必须为查询创建合适的索引.

MySQL官方文档中的不同语句的锁行为](https://dev.mysql.com/doc/refman/8.0/en/innodb-locks-set.html)详细列举了各个场景下InnoDB对锁的处理方式, 此处不再展开讨论. 在实际应用中, 首先要根据业务场景, 选择正确的事务隔离级别和锁方式, 如一致性非锁定读或锁定读, 并正确建立索引. 其次要考虑锁特性对并发性能的影响, 及文档中提及的一些复杂场景中可能产生的如"死锁"等问题.

# 幻读行

幻读是指同一事务内不同时间的相同查询返回了不同结果, 举例来说, 同样的`SELECT`执行了两次, 但第二次返回了第一次没有返回的记录, 这些记录就被称为"幻读行".

沿用之前的例子, 假设在child表的id字段上存在索引, 然后我们查找并锁定所有id大于100的记录, 用于之后的更新:

```mysql
SELECT * FROM child WHERE id > 100 FOR UPDATE;
```

查询从索引第一条大于100的记录开始扫描. 假设现在child表中存在90和102两条数据, 如果只锁定记录而不锁这些记录前的间隙(在当前例子中, 就是90和102间的间隙), 那么其他事务可以在这一间隙上插入记录101, 此后如果我们在当前会话中重新执行此`SELECT`语句, 就会看到数据101(一个幻读行), 这就违背了已读取数据在事务期间不会更改的事务隔离原则.

为了避免幻读现象, 正如前文所提到的, InnoDB使用临键锁算法将记录锁和间隙锁合并. 当查找扫过索引范围时, 将在记录和记录前的间隙上都加上共享或排他锁, 当范围涉及最后一条记录之后时, InnoDB也会在这个间隙上加锁, 在前面的例子中, 就是记录102后的间隙.

临键锁的特性可以帮助应用手动实现唯一性逻辑, 即首先以`FOR SHARE`方式进行查询, 其他事务在该范围上的插入操作会被阻塞, 当前事务在确认唯一性后进行插入.

如果禁用间隙锁, 则可能导致幻读现象的出现.

# 死锁

死锁现象即多个事务彼此持有对方等待的锁, 因此这些事务都被阻塞. 造成这一现象的原因是多个事务以不同的顺序取相同表或行集合上的锁, 或由于一些原因各自持有了请求范围内的一部分锁.

这些方法可以避免死锁:

- 尽量不要使用`LOCK TABLES`.
- 单个事务中应减少插入或更新的记录数量, 避免某一事务长时间内持有大量锁.
- 多个事务在更新多表或大范围行时应采取相同顺序.
- 在如`SELECT ... FOR UPDATE`和`UPDATE ... WHERE`这样的语句会使用的列上建立索引.

事务的隔离级别更改了读操作的行为, 但通常死锁是由写操作导致的, 因此事务的隔离级别不会影响死锁.

默认情况下, InnoDB会检测死锁并回滚某些事务. 如果用户通过`innodb_deadlock_detect`配置禁用了死锁检测, InnoDB将依赖`innodb_lock_wait_timeout`来在死锁时回滚事务. 因此, 即使逻辑是正确的, 业务代码也必须处理事务回滚后的重试逻辑. 可以通过`SHOW ENGINE INNODB STATUS`来查看最近一次死锁的信息. 如果经常出现死锁问题, 可以启用配置`innodb_print_all_deadlocks`来在错误日志中打印所有的死锁信息.

举例来说:

```mysql
# In Session A:
CREATE TABLE qux(i INT) ENGINE = InnoDB;
INSERT INTO qux(i) VALUES (1);
START TRANSACTION;
# 获取共享锁
SELECT * FROM qux WHERE i = 1 FOR SHARE;
# +---+
# | i |
# +---+
# | 1 |
# +---+

# In Session B:
START TRANSACTION;
# 获取排他锁, 由于会话 A 持有共享锁, 将被阻塞.
DELETE FROM qux WHERE i = 1;

# In Session A:
DELETE FROM qux WHERE i = 1;
# Error(1213) ...
```

InnoDB检测到死锁时, 会尝试将影响较小的事务回滚. 当`innodb_table_lock = 1; autocommit = 0;`时, InnoDB可以感知MySQL级别及其他存储引擎造成的表锁定状态. 如果不属于这种情况, 则依赖于`innodb_lock_wait_timeout`设置.

InnoDB回滚事务时, 将释放所有事务持有的锁. 但如果只是由于错误而导致回滚了单条语句, 则锁不会被释放, 因为InnoDB的锁存储格式无法区分锁来源于事务内具体的某一条语句.

如果InnoDB输出"TOO DEEP OR LONG SEARCH IN THE LOCK TABLE WAIT-FOR GRAPH, WE WILL ROLL BACK FOLLOWING TRANSACTION", 表示等待的事务超过200个, 或检查过程中检测到持有的锁超过1000000, 这种情况也会被视为死锁, 因此事务会被回滚.

在高并发系统中, 为了降低死锁检测带来的影响, 可以手动禁用该功能并依赖锁超时时间.