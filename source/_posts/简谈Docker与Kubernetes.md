---
title: 简谈Docker与Kubernetes
date: 2018-01-19 17:54:58
tags:
- Docker
- Kubernetes
- DevOps
- Microservices
categories:
- Linux & DevOps
thumbnail: "/images/简谈Docker与Kubernetes.jpg"
---
去年实习期间主要工作内容之一就是一直和容器化打交道，当时也花了不少心思，假期闲着没事总结一下吧。

# 为什么需要这些
当代码阶段性写完需要转交测试人员测试或者转交运维人员部署上线的时候就有很多头痛的问题：比如明明在我的机器上可以跑起来的项目到了别人的机器上各种报错，操作系统发行版不同导致搭建相同的依赖环境十分困难等等。大型项目通常有多个后端服务器，运维人员想把测试通过的项目部署到多台服务器上也是一件十分繁琐的事，即使像Ansible这样的批量管理工具对于架构微服务化的项目似乎也还是在刀耕火种。项目容器化与容器编排工具的主要作用之一就是解决上述问题。

# Docker与容器化
这里只谈谈Docker的基本原理和使用场景，想要直接上手的童鞋还是去要[官方文档](https://docs.docker.com/)看一看。
我们考虑一个简单场景，我在Arch Linux的系统上安装了Docker，并运行了一个Ubuntu的容器，并在容器中使用Ubuntu的各项功能。Docker在功能听起来有点类似虚拟机，同样是提供了一个隔离的，可迁移的环境。但在原理上Docker与虚拟机并不同，Docker利用了Linux的一些技术实现了容器间隔离，开销比起虚拟机翻译系统API要小的多，是更加轻量的解决方案，我们简单展开谈谈。

## 镜像与容器
我们通过编写**Dockerfile**构建镜像，Dockerfile规定了我们即将构架的镜像基于什么环境，如何初始化，运行哪些服务等。Dockerfile中的每一条指令都会为构建中的镜像添加一个只读层，直到镜像构建成功。镜像运行后便成为了容器。在容器中，镜像本身的文件是不再可写的，容器为此提供一个额外可写层，容器中的写操作都会通过**写时复制(Copy on Write)**写入可写层中，而镜像本身不会发生任何变化。容器虽然提供可写层，但对于重要的持久化内容，通常会利用数据库或挂载点而不会写到可写层里，因为可写层性能不高并且会随着容器的移除而消失。我们通过运行不同的镜像快速构建服务，通过将镜像上传到**Registry**并在其他机器上拉取来迁移镜像。
{% codeblock %}
FROM python:3.6-slim
COPY . /app
RUN pip install -r requirements.txt
CMD python app.py
{% endcodeblock %}

## Storage Driver
Linux中提供一种名为UnionFS的机制实现多个文件系统联合挂载至同一挂载点，而Dockerd在构建镜像时利用此特性将多个可复用的层合并。UnionFS有多种实现方案，也即Docker文档中提到的存储驱动。根据Docker版本，文件系统及Linux发行版本及内核版本等因素的不同，Docker会采用不同的存储驱动。在早期Ubuntu中使用AUFS作为默认存储驱动，在CentOS中为devicemapper，在新版Ubuntu及Archlinux则为**overlay2**，同时overlay2也是目前Docker推荐采用的存储驱动。

## Namespace
命名空间(Namespace)是Linux为我们提供的用于分离进程树、网络接口、挂载点以及进程间通信等资源的方法。当我们在Linux里运行多个服务时，这些服务实际上是相互影响的，每一个服务对其他服务都是可见的，也可以任意访问宿主机上拥有权限的文件。有的时候这不是我们想要看到的，我们希望服务之间彼此隔离。命名空间就是实现了这样的功能，每一个运行着的Docker容器都各自拥有与宿主机隔离的进程空间和网络空间，Dockerd进程启动后在本地添加了docker0虚拟网桥，默认情况下，Dockerd会在docker0与每个容器间建立一对虚拟网卡并将docker0设为容器的默认网关。通过在启动时配置端口映射，dockerd在宿主机iptables配置中将特定请求转发至docker0，从而实现容器在隔离的网络环境下与外部互通。此外，Docker通过挂载目录，Chroot等机制限制容器对文件的访问。
{% codeblock %}
$ sudo brctl show
bridge name	bridge id		STP enabled	interfaces
docker0		8000.02424657ac55	no
$ sudo iptables -t nat -L
Chain DOCKER (2 references)
target	prot	opt	source		destination
RETURN	all	--	anywhere	anywhere
{% endcodeblock %}

## CGroups
我们已经讨论了容器在进程，网络和存储空间上的隔离，而CGroups则为容器提供了物理设备的隔离。CGroup是Linux用于控制进程占用如CPU，内存等物理资源的机制。通过对Docker容器进程的限制从而对容器可见的物理资源加以控制。

# 从Docker到Kubernetes
Docker为我们提供了容器化，我们可以**将项目本身连同环境一起纳入版本控制与持续集成系统中**。当我们提交代码，持续集成系统根据Dockerfile为我们自动构建镜像，测试人员拿到镜像运行为容器进行测试，测试通过后镜像转交运维人员进行部署。借助Docker提供的虚拟化技术，测试人员和运行人员可以更少的关心项目运行环境而把更多的精力放在业务或架构上，大致似乎就是这样了。那么Kubernetes又是什么呢？

# Kubernetes与容器编排

## 容器编排工具
我们将一个大型项目拆分成很多微服务，定义好接口并由不同的开发者分工开发，借助Docker的容器化技术将项目与其依赖共同打包并通过测试人员测试，现在需要部署上线。假设出于地区网络延迟，容灾备份，负载均衡等因素的考虑，公司有128台服务器需要部署当前服务，并且出于稳定考虑，决定仅灰度发布，即仅将一部分服务器上的服务进行更新，比如那些面向申请测试的用户的服务器，如果发布后稳定运行一段时间没有出现问题，则全量更新。这是一个非常常见更新线上服务流程的例子。如果没有Docker这会麻烦更多，但现在我们只需要更新容器的版本就可以了。那么如何更新这些容器呢，并不需要我们分别SSH到这一百多台服务器上去手动执行相同的命令，也不是写脚本或者利用Ansible批量执行，因为这些方法不但繁琐而且存在很多问题，这里就需要提到容器编排工具。容器编排工具的作用顾名思义，就是面向服务器集群，在集群上管理容器，即部署容器到特定的服务器上，指定更新服务器上容器，移除和调整集群上的容器等，当然其功能不止于此。

## Kubernetes
Docker的中文释义为码头工人，Kubernetes的中文释义为舵手。Kubernetes通常也被简称为**K8S**，是由Google开源的容器编排工具。Docker开发公司对服务器集群提供了Swarm解决方案，但K8S更灵活，功能更强大，因而成为了很多公司的选择。要了解K8S，首先要了解K8S中的一些基本概念。
K8S管理的服务器集群称为**Cluster**，Cluster物理上由多台服务器组成，每台服务器被称为一个**Node**，而Node中运行着K8S管理进程kubeadm的被称为**Master**，我们可以通过kubectl工具与kubeadm进程通信从而管理集群。Node节点运行Dockerd以及**Node Process**，Node Process用于控制Dockerd行为，与Master节点协同，监控Node状态并心跳报告等。
{% asset_img "Cluster与Deployment.svg" %}
当我们需要将一个**Application**发布的时候，需要首先创建一个**Deployment**，这个Deployment会被提交至Master，告诉Master如何创建和更新这个Application，此后这个Application的生命周期就会由K8S管理，如果Application的生命周期意外的结束了，K8S会自动重启和调度，这也一定程度上保证了服务的高可用。当我们创建Deployment的时候，K8S会寻找一个合适的Node并在其上创建一个**Pod**，Pod是K8S用来抽象一个或一组运行中的容器的单位，并且在同一个Pod中的容器被保证运行在同一个Node上，并可以共享一些资源，如共享存储卷，共享IP地址（实际上对于一个Cluster，一个Pod对应一个内网IP，此IP默认对外不可见）。Pod是K8S调度的最小单元，Pod可以理解为一个逻辑主机，通常我们将一些强耦合的容器置于一个Pod中。
{% asset_img "Node与Pod.svg" %}
Pod拥有自己独立的生命周期，当Pod由于一些原因意外结束，K8S为使整个系统达到预定的状态，也许会在另一个Node上重新创建这个Pod，但在实际环境中，Front-end程序不应当感知到Back-end服务的这一变动，并且前面提到，Pod虽然拥有IP，但IP并不可以直接被外部访问，基于这些原因，我们把多个具有一定相关性的Pod打上相同**Label**成为一个**Service**，而对于一个Service，我们可以配置其与外部的通信方式（Cluster内部可见IP，基于NAT在所有Node上开放对应端口，创建一个额外的负载均衡器，或利用K8S的DNS通过CNAME记录暴露服务）。而Service的存在使得隐藏于其后的Pod的生命周期不会影响到正在运行的Application。
{% asset_img "Service与Label Selector.svg" %}
同时也正是由于Service的存在，使得弹性伸缩易于实现，我们根据需要调整Service中Pod的数量，这在Kubernetes中称为**Replication**，而这一行为对应**Scaling**。
{% asset_img "弹性伸缩_0.svg" %}
{% asset_img "弹性伸缩_1.svg" %}
同样，Service也使滚动升级成为可能，由于Pod的删除和重建对外不可见，因此可以删除并重建部分不服务的Pod来达到更新的目的，而更新过程中的流量可以导向仍未删除的Pod，直到全部Pod更新完毕，而这一行为对应**Rolling Update**。
{% asset_img "滚动更新_0.svg" %}
{% asset_img "滚动更新_1.svg" %}
{% asset_img "滚动更新_2.svg" %}
{% asset_img "滚动更新_3.svg" %}

# 总结
借助Docker，我们将环境连同项目共同纳入版本控制。借助Kubernetes，我们能够轻松的管理集群上的服务，甚至基于Kubernetes提供的[RESTful API](https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.9/)与现有持续集成系统结合，实现从代码更新，到进入测试环境，到灰度发布，最后到全量更新的自动化。容器化与容器编排工具使运维工作更加安全高效，在未来势必有很大的发展前景。

# 参考资料
1. [Docker Documentation](https://docs.docker.com/)
2. [Docker 核心技术与实现原理](https://draveness.me/docker)
