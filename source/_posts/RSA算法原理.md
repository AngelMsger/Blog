---
title: RSA算法原理
date: 2020-07-19 20:25:42
tags:
- Security
- DevOps
- Algorithm
mathjax: true
thumbnail: "/images/banner/RSA算法原理.jpg"
typora-root-url: ../../source/
---

本文介绍RSA算法的核心原理.

RSA加密算法的应用想必大家已经比较熟悉了, 他是计算机领域中一种非常常见的, 基于公私钥的非对称加密算法, 该算法的可靠性源自大数因数分解的复杂度, 用通俗的例子来说, 假如你有若干桶不同颜色的颜料, 你挑选其中几桶按一定比例混合出新的颜色很容易, 但把混合后的新颜色交给你让你倒推出它由那几桶颜料以何种比例混合而成却很难.

虽然大多数情况下我们使用该算法并不需要理解其原理细节, 但RSA算法本身却常常出现在测试题目或面试问题中, 下面我们从数学的角度对该算法进行介绍.

# 数学基础

## 素数和互素

除了1和本身外, 不能被其他正整数整除的数称为素数.

若两个正整数$x$和$y$除了1以外没有其他公因数, 则$x$与$y$互素.

两个素数必然互素.

互素的正整数未必都是素数, 如2和7互素, 但2不是素数.

## 欧拉函数

欧拉函数$\varphi (x)$的值, 表示小于等于$x$的正整数中与$x$互素的数的个数. 其详细的计算推导可以参考[维基百科](https://www.wikiwand.com/zh-hans/欧拉函数).

对于本文, 需要了解以下性质:

若$x$与$y$互素, 则$\varphi{(xy)}=\varphi{(x)}\varphi{(y)}$.

若$x$为一素数, 显然区间$[1,x)$内的全部正整数均与$x$互素, 因此$\varphi{(x)}=x-1$.

## 扩展欧几里得算法

即辗转相除法, 是一种求解两个正整数最大公因数的方法.

该算法可简述为, 若$x<=y$, 则$gcd(x,y)=gcd(x,x\mod (y))$.

扩展欧几里得算法指出, 在通过欧几里得算法求解$gcd(x,y)$的过程中, 可同时求得参数$a$和$b$, 满足$ax+by=gcd(a,b)$. 将$x$和$y$代入扩展欧几里得算法通常也记作$exgcd(x,y)$, 其详细的计算推导可以参考[维基百科](https://www.wikiwand.com/zh-hans/扩展欧几里得算法).

## 同余

若两个正整数$x$和$y$除以正整数$m$得到的余数相同, 则$x$与$y$关于模$m$同余, 记作:

$x\equiv{y\pmod{m}}$

同余是一种等价关系.

## 模反元素

若$ab\equiv{1\pmod{n}}$, 则称$b$为$a$关于模$n$的一个模反元素.

若$a$和$n$互素, 则其模反元素$b$必然存在.

可通过扩展欧几里得算法求解模反元素, 通过$exgcd(a,n)$得到$ax+ny=g$, 其中$g$为$a$和$n$的最大公因数, 若$g=1$, 则$x$即为$a$关于模$n$的一个模反元素, 其详细的计算推导可以参考[维基百科](https://www.wikiwand.com/zh-hans/扩展欧几里得算法).

也可通过欧拉定理求解模反元素.

# RSA

## 密钥对生成

依次得到六个值:

1. 任取素数$p$
2. 任取素数$q$.
3. $n=p*q$.
4. $\varphi{(n)}=\varphi{(p)}\varphi{(q)}=(p-1)(q-1)$.
5. 任取整数$e$, 满足$1\in{(1,\varphi{(n)})}$且$e$与$\varphi{(n)}$互素.
6. 通过扩展欧几里得算法求得$e$关于模$\varphi{(n)}$的模反元素$d$.

## 加密

由$n$和$e$共同组成公钥, 公钥可以被公开. 消息发送人通过公钥对明文进行加密.

明文$m$必须是整数(字符串或其他格式的内容在计算机中也可以转换为整数). 通过以下表达式得到密文$c$:

$m^e\equiv{c\pmod{n}}$

在编程语言中通常也写为:

```python
c = m ^ e % n
```

## 解密

由$n$和$d$共同组成私钥, 含私钥在内, 除公钥外的其他参数均不能泄露. 消息接收人通过私钥对密文进行解密.

可通过一下表达式得到明文$m$:

$c^d\equiv{m\pmod{n}}$

在编程语言中通常也写为:

```python
m = c ^ d % n
```

## 破解

如果仅通过公钥$n$和$e$推算出私钥$d$, 则RSA算法即被破解. 由前文可知:

1. $ed\equiv{1\pmod{\varphi{(n)}}}$, 由于$e$为已知公钥参数, 因此求解依赖参数$\varphi{(n)}$
2. $\varphi{(n)}=(p-1)(q-1)$, 因此求解依赖参数$p$和$q$.
3. $n=pq$, 因此求解需要对$n$进行素数分解.

目前, 素数分解的途径仅有暴力破解, 即通过欧拉筛法或[P'ollard's rho]([https://www.wikiwand.com/en/Pollard%27s_rho_algorithm](https://www.wikiwand.com/en/Pollard's_rho_algorithm))算法搜索位于区间$[2,\lfloor{\sqrt{n}}\rfloor]$上的所有素数并尝试, 以现有计算机的算力, 该过程代价极大. 人类目前分解的最大整数包含768个二进制位, 而实际应用中选取$n$的二进制位个数通常大于1024, 因此我们可以认为秘钥是安全的.