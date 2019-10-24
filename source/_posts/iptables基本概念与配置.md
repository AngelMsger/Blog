---
title: iptables基本概念与配置
date: 2018-02-20 15:04:17
tags:
- iptables
- Linux
- Security
- DevOps
categories:
- Linux & DevOps
thumbnail: "/images/banner/iptables基本概念与配置.jpg"
typora-root-url: ../../source/
---
去年学习过iptables相关的很多内容，这里分几篇文章总结一下，本篇介绍基本概念与使用。

# 防火墙
防火墙是保证网络安全中常用的工具，最常见的需求是允许某些用户的满足某些要求的访问，而阻止其其他行为。比如屏蔽所有人对blog.angelmsger.com除80(HTTP)和443(HTTPS)端口外的访问，但放行苏州大学网段内对22(SSH)端口的访问，或者在公司内部禁止对taobao.com和jd.com服务器的发起连接以阻止员工在上班期间剁手等。防火墙是在网络中保护主机安全的重要屏障。

# iptables
**iptables**本身并不是防火墙，在Linux中实现防火墙机制的实际上是**netfilter**，我们可以把iptables理解为一个壳甚至一个操作netfilter的命令行工具。但在讨论的时候我们也常常简单的把iptables视为防火墙。

## 基础理论

### 链
iptables是按照指定的**规则(Rules)**来办事的，配置iptables实际上就是对规则的曾删改查。比如说我的服务器开放了Web服务，现在你要访问我的Web服务，客户端发起请求，报文发送到服务器网卡，终点为套接字(123.206.23.171:443)，这个请求在到达Web服务(Nginx)之前实际上必须先通过系统防火墙设置的关卡，这也是很多同学照着教程在服务器上跑起来Nginx后自己却不能访问的原因，因为我们添加规则来告诉iptables放行目标是80和443端口的请求。在iptables中，这些关卡被称为**链**。有的时候，当前主机并不会真正的处理请求，而是转发给其他主机。当我们启用iptables，则与本机相关的报文有可能有如下情况：

![iptables原理](/images/iptables%E5%9F%BA%E6%9C%AC%E6%A6%82%E5%BF%B5%E4%B8%8E%E9%85%8D%E7%BD%AE/iptables%E5%8E%9F%E7%90%86.png)

如图，绿色方块即为前文中的链：

1. 到本机某进程的报文：PREROUTING -> INPUT
2. 经过本机转发的报文：PREROUTING -> FORWARD -> POSTROUTING
3. 有本机进程发出的报文：OUTPUT -> POSTROUTING

这些关卡之所以被称作链，是因为每个关卡对应路径上的一个阶段，并且由一系列定义该阶段的规则串联而成。除此之外，我们也可以新建自定义链，但自定义链不会直接起作用，而需要被系统的链调用。

### 表
iptables中还存在一种规则，即为**表**。我们在每条链上都制定了规则，规定了在链对应阶段，如果匹配到满足**某些条件**的报文则执行**某些操作**。这里制定的规则可以根据目标功能被分类存放。在iptables中，预先提供了4张表，优先级由低至高：
1. filter：过滤，即传统意义上的防火墙
2. nat：网络地址转换
3. mangle：拆解，修改并重新封装
4. raw：关闭nat表启用的连接追踪机制

因此，在每条链上，规则又按表(按功能)进一步划分。同时也要注意到，由于链本身代表路径上的一个阶段，因此每条链上可以出现哪些表的规则也是有规定的，具体如下。
1. INPUT：mangle -> nat -> filter
2. OUTPUT：raw -> mangle -> nat -> filter
3. PREROUTING：raw -> mangle -> nat
4. FORWARD：mangle -> filter
5. POSTROUTING：mangle -> nat

我们也可以由此反向总结出每张表中可以出现哪些链上的规则，这里就不赘述了。

### 规则
前面笼统的提到了规则，主要是为了解释链与表，没有提及细节，这里展开谈谈。正如前文所说，规则实际上就是对报文的**匹配条件**和**执行动作**。

#### 匹配条件
1. 基本匹配条件：源地址(Source IP)与目标地址(Destination IP)
2. 拓展匹配条件：选择性更多也更加细致的条件，但依赖各个拓展模块。

#### 执行动作
1. ACCEPT：接受(放行)
2. DROP：丢弃数据包，不予回应
3. REJECT：拒绝，必要时通过--reject-with参数给予响应信息
4. SNAT：源地址转换，适用于内网用户使用共用地址对外发出请求
5. MASQUERADE：SNAT的特殊形式，适用于动态IP
6. DNAT：目标地址转换，适用于将外部返回的报文转发给内网接受者
7. REDIRECT：本地端口映射
8. LOG：记录日志并传递给下一条规则

### 网络防火墙
前文介绍的都是针对指定机器的配置，但iptables同样支持配置为网络防火墙。

![网络防火墙](/images/iptables%E5%9F%BA%E6%9C%AC%E6%A6%82%E5%BF%B5%E4%B8%8E%E9%85%8D%E7%BD%AE/%E7%BD%91%E7%BB%9C%E9%98%B2%E7%81%AB%E5%A2%99.png)

在网络防火墙中，iptables的作用将不仅局限于过滤，同时还需要用到转发。我们用一台与外网连接的多网卡主机作为网络防火墙并配置iptables，启用该主机的转发功能，将内网的其他主机的网关设置为这台主机，简单的拓扑结构如上图所示。开启内核转发功能：

```shell
sudo echo 1 > /proc/sys/net/ipv4/ip_forward
```

这样，就可以在主机上配置转发相关的规则了。

## 动手实践

### 查看规则
iptables是我们使用的主要命令，-t参数指明哪一张表，-n表示不必对IP地址进行名称反解以加快显示速度，-v参数表示列出详细信息，-L参数表示列出规则，--line-numbers参数表示显示规则编号。查看filter表中的规则：

```shell
sudo iptables -nvL -t filter --line-numbers
Chain INPUT (policy DROP 0 packets, 0 bytes)
num   pkts bytes target     prot opt in     out     source               destination         
1        0     0 ACCEPT     all  --  lo     *       0.0.0.0/0            0.0.0.0/0           
2    6699K  670M ACCEPT     all  --  *      *       0.0.0.0/0            0.0.0.0/0            state RELATED,ESTABLISHED
3    33641 1963K ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            state NEW tcp dpt:22
4    23222 1374K ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            state NEW tcp dpt:80
5    10630  573K ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            state NEW tcp dpt:443
6     153K   14M ACCEPT     icmp --  *      *       0.0.0.0/0            0.0.0.0/0            limit: avg 1/sec burst 10
7        0     0 ACCEPT     all  -f  *      *       0.0.0.0/0            0.0.0.0/0            limit: avg 100/sec burst 100
8        1    52 syn-flood  tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            tcp flags:0x17/0x02
9     4590  217K REJECT     all  --  *      *       0.0.0.0/0            0.0.0.0/0            reject-with icmp-host-prohibited

Chain FORWARD (policy DROP 0 packets, 0 bytes)
...
```

这里简单说明一下输出各列的含义：

1. pkts：规则匹配到报文个数
2. bytes：规则匹配到报文大小总和
3. target：匹配后得到执行动作
4. prot：规则匹配的协议
5. opt：规则对应选项
6. in：规则匹配报文流入接口(网卡)
7. out：规则匹配报文流出接口(网卡)
8. source：规则匹配报文源IP地址
9. destination：规则匹配报文目标IP地址

从结果可以看出，INPUT，FORWARD，OUTPUT链都可以包含filter表中的规则。因此当我们需要过滤功能时，可以在filter表中新建规则，并添加到指定链上。具体选择哪条链取决于工作场景。比如我们要禁止其他主机访问本机，考虑到对应链路由为PREROUTING -> INPUT，因此只能把规则定在这两个链上，但起过滤作用的filter表中的规则不能定义在PREROUTING上，因此我们只能选择INPUT。我们也可以不指定-t参数，默认即为filter表。
在上述输出结果中表名后的括号里，是表的默认策略，即如果没有规则匹配到执行的默认操作。易于理解，当默认策略为ACCEPT时，我们定义的规则实际上是一个"黑名单模式"，反之，若默认策略为DROP/REJECT时则为"白名单模式"。有一个技巧点这里需要提到，那就是"黑名单模式"和"白名单模式"之间的选择问题。实际生产环境中，我们通常只开放业务所需的端口，而拒绝对其他端口的访问，因此常常需要使用"白名单模式"，但将默认策略设置为DROP或REJECT实际上是有隐患的，因为一旦我们误用了`iptables -F`命令导致规则被清空，则我们再也无法使用SSH远程连接我们的服务器。因此实际环境中我们通常使用以下方式达到同样地效果，将默认策略设置为ACCEPT，但在规则尾部将除其他规则匹配外的数据包拒绝：

```shell
sudo iptables -P INPUT ACCEPT
sudo ...
sudo iptables -A INPUT -j REJECT
```

这样，即使规则被错误的清空，我们依旧可以连接服务器并重新配置。

### 修改规则
我们也可以在后面追加INPUT以只列出INPUT链上(filter表中)的规则。了解如何列出规则之后，我们看看如何修改。这里多说一句，大家学习过程中不要在自己的远程服务器上尝试，改错了又保存了的话SSH不到服务器上就要重装系统了。指定-F参数以清空原有规则：

```shell
sudo iptables -F INPUT
```

-I参数可以帮助我们在链首部插入一条规则，-s参数表示源地址，-j参数表示符合规则时执行的动作。添加指令，丢弃来自192.168.151.198的数据包：

```shell
sudo iptables -t filter -I INPUT -s 192.168.151.198 -j DROP
```

此时我们从192.168.151.198已经ping不通本机了，因为ping依靠返回的ICMP数据包来工作，但我们的iptables根据规则将所有来自192.168.151.198的包都丢弃了并且没有给予任何返回。我们也可以将-I参数换位-A参数来在链的末尾追加规则，值得一提的事，规则的匹配是又上至下顺序的，因此更前面的规则优先级更高。
接下来试试删除一条规则，指定-D参数以删除filter表中INPUT链上编号为5的规则：

```shell
sudo iptables -t filter -D INPUT 5
```

我们也可以输入类似新建规则时使用的其他参数以进行删除匹配项，这里就不演示了。我们可以使用-R参数来修改已有的规则，但修改时必须把非修改部分也全部写出来，否则修改之后那些没有显式写明的部分将被清除。因此实际上你也可以删除并重新添加修改后的规则来实现相同的目的以避免"修改"带来的歧义。我们也可以修改链的默认执行动作。指定-P参数以将FORWARD链的默认执行动作改为DROP：

```shell
sudo iptables -t filter -P FORWARD DROP
```

我们也可以基于协议进行匹配，拒绝来自192.168.151.198，目标为192.168.151.199，且协议为TCP的报文：

```shell
sudo iptables -I INPUT -s 192.168.151.198 -d 192.168.151.199 -p tcp -j REJECT
```

在上述命令生效后，我们尝试从192.168.151.199向192.168.151.198发起SSH连接则会被拒绝，而发起Ping请求则是可以的，如前文所述，Ping通过ICMP协议工作。-p参数支持以下协议：tcp，udp，udplite，icmp，icmpv6，esp，ah，sctp，mh。
我们还可以基于网络接口(网卡)来匹配数据包，拒绝来自网卡eth1，且协议为ICMP的包：

```shell
sudo iptables -I INPUT -i eth1 -p icmp PREROUTING -j REJECT
```

-i是匹配流入网卡，因此只能加在PREROUTING，INPUT，FORWARD链上。也可以讲参数换为-o来表示对匹配流出网卡，-o参数只能加在FORWARD，OUTPUT，POSTROUTING链上。
以上我们所作的配置都是临时修改，重启后便不再有效果了。我们需要手动保存，当然也可以直接修改位于/etc/sysconfig/iptables的配置文件。利用iptables-save来保存配置：

```shell
sudo iptables-save > /etc/sysconfig/iptables
```

也可以利用iptables-restore命令来从指定文件中载入配置，这里不再演示。我们还可以在-s参数后填写多个IP，也可以直接填写网段，还可以用!取反，或将参数-s换为-d以匹配目标地址。
iptables还可以用来做本地端口转发，将目标为80端口且协议为TCP的数据包转发至8080端口：

```shell
sudo iptables -t nat -A PREROUTING -p tcp -m tcp --dport 80 -j REDIRECT --to-ports 8080
```

### 自定义链
规则逐渐增多后管理起来就很麻烦，如果我们有几百条规则，其中有8条是关于Web服务流入数据包的，现在想要找到这些规则就变成了繁琐的事情。我们尝试使用iptables为此提供的自定义链功能，此处使用了拓展模块，拓展模块将在{% post_link "iptables拓展模块的网络地址转换" "下篇文章" %}中介绍，添加自定义链并应用：

```shell
sudo iptables -N WEB_IN
sudo ...
sudo iptables -I INPUT -p tcp -m multiport --dports 80,443 -j WEB_IN
```

# 总结
本篇介绍了防火墙的主要作用，iptables中5条链4张表的基本概念，规则的查询与修改，这些都是iptables的基本用法。但iptables的作用远不止于此，[下篇文章](../iptables拓展模块和网络地址转换)我们介绍iptables拓展模块的使用。

# 参考资料
[朱双印个人日志中关于防火墙的系列文章](http://www.zsythink.net/archives/category/运维相关/防火墙/)
