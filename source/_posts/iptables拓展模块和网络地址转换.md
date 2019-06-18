---
title: iptables拓展模块和网络地址转换
date: 2018-02-22 10:45:15
tags:
- iptables
- Linux
- Security
- DevOps
categories:
- Linux & DevOps
thumbnail: "/images/iptables拓展模块的网络地址转换.jpg"
---
{% post_link "iptables基本概念与配置" "上一篇文章" %}我们介绍了iptables的基本概念与配置，实现了针对主机，协议及网络接口的数据包的操作。但iptables仅关于数据包匹配的功能也远不止如此，iptables提供了许多拓展模块，这些拓展模块能够帮助我们完成更加高级的匹配。本文来讨论一下拓展模块的使用。

# 高级匹配与拓展模块
我们要使用拓展模块时，需要用-m参数指定模块的名字，并填写模块的参数。不同的模块实现不同的匹配功能。此处多说依据，大家可以看到文中提到的例子中多用**DROP**和**REJECT**作为执行动作而非**ACCEPT**，是因为这里启用的是**黑名单模式**，即对于规则匹配不到的数据包均会放行。实际配置中请务必留意此默认策略。同时，另一个值得注意的点是，**规则只会对匹配到的包生效，并不会对匹配不到的包执行相反动作**。比如如下指令，放行来自192.168.151.198的数据包：
{% codeblock "放行来自192.168.151.198的数据包" %}
# iptables -t filter -I INPUT -s 192.168.151.198 -j ACCEPT
{% endcodeblock %}
以上指令并不隐含拒绝来自除了192.168.151.198以外的数据包的意思。如果我们的默认执行动作为ACCEPT，则来自其他主机同样会被放行。这一规则对于下文中的各项功能同样适用。

## 端口
针对端口号的规则是我们使用防火墙最常用的需求之一，比如，拒绝目标为8080/tcp端口的数据包：
{% codeblock "拒绝目标为8080/tcp端口的数据包" %}
# iptables -I INPUT -p tcp -m tcp --dport 8080 -j REJECT
{% endcodeblock %}
端口匹配属于拓展匹配条件，因此依赖拓展模块。在匹配端口时我们**必须指定协议**，因此此处-p参数指定匹配TCP协议。命令中的第二个tcp不再指协议，-m参数的含义是依赖模块，这里指调用名为tcp的拓展模块，此处-m参数可被省略，因为--dport会默认使用tcp模块。--dport指匹配的目标端口。我们也可以把--dport参数换为--sport来表示源端口，但tcp模块不支持配置多端口，如果要匹配多端口我们需要换用multiport模块，并讲--dport参数换位--dports参数，多端口间用逗号隔开，且不能加空格。放行目标端口为22到25，以及80和443的数据包：
{% codeblock "放行目标端口为22到25，以及80和443的数据包" %}
# iptables -I INPUT -p tcp -m multiport --dports 22:25,80,443 -j ACCEPT
{% endcodeblock %}

## IP范围
iptables的-s和-d参数可以指定单个，多个IP或IP网段，但不支持IP范围(如192.168.151.190-192.168.151.199)，我们可以使用iprange拓展模块的--src-range与--dst-range参数来控制。丢弃来自192.168.151.190-192.168.151.199且协议为UDP的数据包：
{% codeblock "丢弃来自192.168.151.190-192.168.151.199且协议为UDP的数据包" %}
# iptables -I INPUT -p udp -m iprange --src-range 192.168.151.190-192.168.151.199 -j DROP
{% endcodeblock %}

## 字符串
有时会有针对数据包是否包含某些关键词来决定执行动作。string拓展模块可以帮助我们实现这一功能。拒绝包含"negative"的字符串的数据包：
{% codeblock '拒绝包含"negative"的字符串的数据包' %}
# iptables -I INPUT -m string --algo bm  --string "negative" -j REJECT
{% endcodeblock %}
此处--algo参数指定字符串匹配算法，可选bm或kmp，通常bm算法效率更好。--string参数指定匹配的关键字。当然，字符串匹配仅对未加密的明文有用，如HTTP。对密文是没有效果的，如HTTPS。

## 时间
time模块可以帮助我们根据数据包到达的时间进行匹配。拒绝周一至周五，早晨8点到下午5点的本机对外的网页请求：
{% codeblock "拒绝周一至周五，早晨8点到下午5点的本机对外的网页请求" %}
# iptables -I OUTPUT -p tcp --dport 80 -m time --weekdays 1,2,3,4,5 --timestart 09:00:00 --timestop 17:00:00 -j REJECT
# iptables -I OUTPUT -p tcp --dport 443 -m time --weekdays 1,2,3,4,5 --timestart 09:00:00 --timestop 17:00:00 -j REJECT
{% endcodeblock %}
除了以上参数外，还可以指定--datestart，--datestop，--monthdays等参数，这里不再演示。

## 连接数量
有时我们想要限制每个IP地址与Server的并发连接数量，以阻止恶意连接。connlimit拓展模块具有此功能。每个IP最多同时建立3个SSH连接：
{% codeblock "每个IP最多同时建立3个SSH连接" %}
# iptables -I INPUT -p tcp --dport 22 -m connlimit --connlimit-above 3 -j REJECT
{% endcodeblock %}
此外，connlimit还支持--connlimit-mask来依据网段(参数为子网掩码中1的个数)对连接进行限制，这里不再演示。

## 带宽
这里说带宽并不十分准确，但名为limit的拓展模块确实能够帮助我们限制单位时间内通过的数据包数量。"每6秒放行一个协议为ICMP的数据包：
{% codeblock "每6秒放行一个协议为ICMP的数据包" %}
iptables -I INPUT -p icmp -m limit --limit-burst 8 --limit 10/minite -j ACCEPT
{% endcodeblock %}
这条指令有点意思，我们这里需要多讨论一下。首先limit拓展模块的工作原理基于一个名叫"**令牌桶**"的算法。这种算法的核心思想是，你要执行动作(此处为放行数据包)时首先要去令牌桶中请求令牌，如果拿到令牌则可以继续执行，否则失败。令牌桶有容量限制，初始为满，我们定期向令牌桶中补充令牌，多出的令牌被溢出不计。令牌桶算法在网络流量整形和速率限制中很常用。上述命令实际上包含以下深意：
1. --limit-burst参数指定令牌桶大小，默认为5，此处为8。
2. --limit参数指定动作执行的速率，此处为每分钟10个，即每6秒1个。

如此设定后，前8个到达的协议为ICMP的数据包会被放行，因为令牌桶初始为满，即包含8个令牌。之后由于我们每6秒补充一个令牌，因此后来到达的数据包每6秒才会由一个成功匹配。我们可以通过另一台主机发起Ping请求以检验效果，但此处多说一句，正如文章开头处提到，规则能否正确实现目的，不仅取决于规则本身是否正确，还取决于默认规则。此处我们需要设定默认规则为REJECT而非ACCEPT。如若不然，即使按照此条规则每6秒匹配并放行1个数据包，但那些没有被本条规则匹配到的数据包同样会在最后被默认规则放行，我们就无法实现目的了。

## TCP数据包协议头
前文在谈到匹配源端口与目的端口的时候，用到了名为tcp的拓展模块。实际上这个拓展模块还有一个实用的功能，那就是按TCP数据包协议头进行匹配。
{% asset_img "TCP数据包协议头.png" %}
TCP数据包协议头内容的含义不是本文讨论的终点，这里限于篇幅不再解释了，忘记的童鞋可以自己搜索复习一下。我们这里做个演示，效果检查依赖于一些抓包工具，如tcpdump或Wireshark。匹配目标端口为22，并检查SYN，ACK，FIN，RST，URG和PSH位，其中SYN必须为1，剩余位必须为0，并拒绝匹配到的数据包：
{% codeblock "匹配目标端口为22，并检查SYN，ACK，FIN，RST，URG和PSH位，其中SYN必须为1，剩余位必须为0，并拒绝匹配到的数据包" %}
# iptables -I INPUT -p tcp -m tcp --dport 22 --tcp-flags SYN,ACK,FIN,RST,URG,PSH SYN -j REJECT
{% endcodeblock %}
也可以使用一些简写参数如--syn来表达同样地含义。

## ICMP数据包协议头
与tcp拓展模块类似，也有名为icmp的拓展模块。ICMP协议主要帮助我们查询和回复网络的状态，其数据包根据含义(目的不可达，拥塞阻塞导致源端关闭，重定向等)分为多类。与TCP数据包协议头类似，这也不是我们的讨论范围，大家可以查阅维基百科的[英文页面](https://en.wikipedia.org/wiki/Internet_Control_Message_Protocol#Control_messages)或[中文页面，需要科学上网](https://zh.wikipedia.org/wiki/互联网控制消息协议#报文类型)。我们这里演示一个例子。拒绝其他主机向本机发送的Ping请求：
{% codeblock "拒绝其他主机向本机发送的Ping请求" %}
# iptables -I INPUT -p icmp -m icmp --icmp-type 8/0 -j REJECT
{% endcodeblock %}

## 连接状态
假设我们希望开放某个端口，通过端口发出请求并等待回复(对应连接有本机首先发起)，但又不希望因为开放端口而被其他无关主机攻击(对应连接由无关主机首先发起)。比如我们有主机A需要访问主机B上的Web服务，主机A因此为其浏览器开放了8080端口并以此与主机B上开放的80端口通信，但我们开放的8080端口仅希望在本机A向B发出请求后接受来自B的回复，而不希望与此过程无关的主机C尝试与A开放的8080端口通信，即实现**仅和有我主动发起并建立连接的主机通信**。为达到此目的，名为state的拓展模块帮助我们根据数据包在连接中的状态来进行匹配。这里的连接使广义的，即不仅限于TCP/IP协议中的连接，我们知道在TCP/IP协议中UDP与ICMP都是没有"握手建立连接"这一过程的，但state拓展模块把主机间你来我往传输数据包的过程都视为连接。state拓展模块将连接中传输的数据包分为5种状态：
1. NEW：建立连接的第一个数据包。
2. ESTABLISHED：连接建立后传输的数据包。
3. RELATED：与已建立的连接相关的数据包(如FTP协议中建立命令连接后数据传输连接对应的数据包)。
4. INVALID：无法识别或无状态的数据包。
5. UNTRACKED：未被追踪或找不到相关信息的数据包。

也可以查看[The state machine](http://www.iptables.info/en/connection-state.html)了解更详细的内容。这里举个例子：
{% codeblock "" %}
# iptables -I INPUT -m state --state RELATED,ESTABLISHED -j REJECT
{% endcodeblock %}
规则添加成功后，通过抓包工具不难验证，第一个数据包是正常的，而之后的数据包被拒绝了。

# 网络地址转换
我们先来简单了解一下网络地址转换(NAT)。网络地址转换也即将收到的数据包中的网络地址改写后再转发，根据改写的是源地址还是目标地址分为SNAT和DNAT。网络地址转换有以下主要用途：
1. 共享IP上网，节省成本的同时也为IPv4地址日渐枯竭的今天作出贡献。
2. 保护内网主机，由于内网主机真实IP对外不可见而提供了一定的安全性。

## 流程说明
一个简单的网络地址转换流程大致是这样：
1. 主机向外发送请求，请求到达网关，网关(拥有公网IP)将数据包内的源地址和源端口记录后改写为自己的地址和自己的某一个端口并向目标转发。目标拿到请求后只能看到网关的地址与端口而对其后的内网主机网络信息一无所知，其处理请求后向网关发送回复。
2. 网关收到回复后，从之前的记录中找到数据包在内网对应的真实接收者，改写数据包的目标地址和目标端口并转发，主机收到回复。

以上过程中网关共执行了2次地址改写。情况也可以反过来，先由公网主机向内网网关发送请求，网关将数据包转发至内网真实接受者，并有接受者回复。根据流程中2个阶段里第一个阶段改写内容，NAT可以分为**SNAT**(先执行源地址改写)和**DNAT**(先执行目标地址改写)。

## SNAT演示
现在假设公司仅有一个对外IP，为192.168.151.198，并且此IP对应为我们主机所属的子网(10.1.0.0/16)网关。现在我们需要共享此网关的IP请求外部服务。通过SNAT改写对外流量源地址：
{% codeblock "通过SNAT改写对外流量源地址" %}
# iptables -t nat -A POSTROUTING -s 10.1.0.0/16 -j SNAT --to-source 192.158.151.198
{% endcodeblock %}
此处我们不需要显式定义被请求的外部主机返回的数据包如何交还内网主机，SNAT执行动作会自动维护NAT表，在第2阶段执行对应的DNAT。

## 动态SNAT演示
有时我们没有固定的公网IP，比如家里的宽带。但SNAT的--to-source参数要求我们为改写声明固定的IP地址，这样一旦我们的公网IP地址发生变化，则SNAT失效需要重新配置，很是麻烦。MASQUERADE动作可以被视为动态的SNAT，只是此时我们不再与IP地址绑定，而是与网卡绑定。网卡通过DHCP协议获取IP地址，MASQUERADE改写数据包源地址时使用网卡获取的IP地址。通过MASQUERADE实现动态SNAT：
{% codeblock "通过MASQUERADE实现动态SNAT" %}
# iptables -t nat -A POSTROUTING -s 10.1.0.0/16 -o eth1 -j MASQUERADE
{% endcodeblock %}
MASQUERADE的代价是其效率不及静态的SNAT，因此没有动态需求的时候不必使用MASQUERADE。

## DNAT演示
现在同样假设公司仅有一个对外IP，为192.168.151.198，并且公司有多项对外服务，分别部署在内网多台服务器上。比如MySQL部署在10.1.0.2上，端口为3306，MongoDB部署在10.1.0.3上，端口为27017。现在通过网关对外IP服务，端口号不变。通过DNAT改写对内流量目标地址：
{% codeblock "通过DNAT改写对内流量目标地址" %}
# iptables -t nat -I PREROUTING -d 192.168.151.198 -p tcp -m tcp --dport 3306 -j DNAT --to-destination 10.1.0.2:3306
# iptables -t nat -I PREROUTING -d 192.168.151.198 -p tcp -m tcp --dport 27017 -j DNAT --to-destination 10.1.0.2:27017
{% endcodeblock %}
现在即可在外网通过同一个IP访问位于内网的两台不同机器上的服务了。

# 总结
iptables的诸多拓展模块使我们匹配具有指定特征的数据包非常方便。但回顾iptables规则的4张表我们就知道，iptables并非仅仅具有过滤数据包的功能，下一篇文章我们继续讨论。

# 参考资料
[朱双印个人日志中关于防火墙的系列文章](http://www.zsythink.net/archives/category/运维相关/防火墙/)
