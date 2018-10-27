---
title: 探索Node.js原理：一
date: 2018-07-23 23:40:16
tags:
- Node.js
- JavaScript
- Event Loop
- LibUV
categories:
- JavaScript
thumbnail: "/images/探索Node.js原理：一.jpg"
---
最近因为工作的原因学习了Node.js，我之前接触JavaScript相对比较少，因此这段时间恶补了不少东西，其中关于JavaScript语言本身本身的学习资料我会在之后整理，但最近读到了[JSBlog](https://jsblog.insiderattack.net)中关于**Event Loop**机制和Node.js原理的系列文章，实在是很不错。我把它翻译一下分享给更多人吧。

当然了，这也并不仅是完全的翻译，算是掺了点自己的理解的复述吧，由于我之前对Node.js也并不熟悉，因此如果由错的地方欢迎大家及时指正。

# Node.js
Node.js与其他服务端开发平台最大的不同在于其处理IO的方式。我们总是听说Node.js是**非阻塞的**，**事件驱动的**，**基于Google开发的V8引擎的**平台，但这些描述究竟代表了什么呢，为了深入了解Node.js，本文探索Node.js中的核心内容之一--**Event Loop**。

# 简化的Event Loop
Node.js工作在事件驱动模型之上，这个模型包含一个事件分发器和一个事件队列，这种模型也可以被解释为[反应器模式](https://www.wikiwand.com/en/Reactor_pattern)。通俗的说，当IO请求到来时，事件分发器将其分发至指定设备去执行，此时调用者并非阻塞等待操作结果，而是可以继续执行队列中的其他任务。当IO操作执行完毕后，事件分发器将此次IO操作结果对应的回调函数加入事件队列，直至调用者至此事件并执行回调函数。这是一个半无限循环，Node.js的执行器会轮询事件队列，直至队列中没有等待执行的回调并且没有其他未完成的IO操作。此过程的简图可以表示为：

{% asset_img "基础模型.jpg" %}

很多网上的文章对Node.js的执行模型言尽于此，但实际上这只是一个非常简化的模型，很多时候甚至不能帮助我们很好的解释一段程序，比如：

{% codeblock "Node.js执行原理测试" lang=javascript %}
setTimeout(() => console.log('set timeout1'), 0);
Promise.resolve().then(() => console.log('promise1 resolved'));
Promise.resolve().then(() => {
    console.log('promise2 resolved');
    process.nextTick(() => console.log('next tick inside promise resolve handler'));
});
Promise.resolve().then(() => console.log('promise3 resolved'));
setImmediate(() => console.log('set immediate1'));
process.nextTick(() => console.log('next tick1'));
setImmediate(() => console.log('set immediate2'));
process.nextTick(() => console.log('next tick2'));
Promise.resolve().then(() => console.log('promise4 resolved'));
setTimeout(() => {
    console.log('set timeout2');
    process.nextTick(() => console.log('next tick inside timmer handler'));
}, 0);
{% endcodeblock %}

你能否给出上述代码的执行输出结果呢？如果你能答对，那说明你对Event Loop机制应当是比较了解了，它的结果应当是：

{% codeblock "输出结果" %}
next tick1
next tick2
promise1 resolved
promise2 resolved
promise3 resolved
promise4 resolved
next tick inside promise resolve handler
set timeout1
set timeout2
next tick inside timmer handler
set immediate1
set immediate2
{% endcodeblock %}

如果你没能完全答对的话，说明你还没有完全掌握Node.js的执行流程，本系列文章应该能为你补齐一些关于Node.js原理方面的知识。

# 真实的Event Loop

## LibUV
实际上Node.js中的时间队列并非只有一个简单的队列，IO也并非全部的事件类型。

{% asset_img "LibUV.png" %}

事件分发器在不同操作系统下有不同的底层实现方案，如Linux下的epoll，BSD下的kqueue，Windows下的IOCP和Solaris下的event ports等，网络IO的非阻塞实现可由这些底层接口提供，而Node.js需要做的则是封装不同平台的实现，从而实现上文中的Event Loop机制，进而最终的程序员能够以异步的方式进行网络编程。

然而除了各个平台的不同实现，另一个麻烦的事实则是令Web程序阻塞操作通常并非只有网络IO，还有文件IO以及基于文件IO的其他服务如DNS等，而很多操作系统并不提供针对此的完全异步接口。在Node.js中使用了线程池解决这些问题。因此也可以看出，一些开发者简单的认为Node.js在后台完全依赖线程池执行所有的异步操作，这种理解也是不对的。

为了像Node.js这样为编程人员创造一个非阻塞的开发平台，首先需要为封装一个跨平台的异步IO层，在Node.js中，这就是[LibUV](http://libuv.org/)。下面这幅摘自官方文档的图片所表述的也是上文所提的内容。

{% asset_img "LibUV结构" %}

## 事件队列
事件队列是一个支持事件入队，并基于Event Loop机制被执行器轮询执行，正如本文开始时提到的反应器模式。但那仅仅是一个被非常简化的模型，Node.js是如何真正实现的呢？

首先，在Node.js中不只存在一个队列，而是针对不同的时间类型存在多个。执行器在一次循环中会顺序轮询每个队列，而执行器轮询一个队列的过程被称作一个**阶段**。

LibUV为实现Event Loop建立了4个队列，分别是：

1. Timeout & Interval：到期的计时器的回调，通过调用`setTimeout`或`setInterval`
2. IO Events：完成的IO操作的回调，如`fs.readFile`指定的文件被读取完毕
3. Immediate：通过`setImmediate`增加的回调
4. Close Handler：所有`close`事件的回调

尽管此处都称为队列，但实际上他们的实现方式从数据结构的角度来讲并非全是队列，比如Timer & Interval就是由一个**小顶堆**实现的。

除了这4个由LibUV实现的队列外，Node.js本身还实现了两个队列，分别是：

1. Next Tick：通过`process.nextTick`添加的回调
2. Promise Microtasks：由`Native Promise`(而不是`q`或`BlueBird`)产生的回调

那么这些队列如何协同工作实现最终的Event Loop呢？先来一幅图：

{% asset_img "Event Loop.png" %}

正如这幅图所描述，Event Loop开始于检查Timer & Interval队列，并不断循环，每遍历一个队列的过程即为前文所提及的**阶段**。执行器不断循环遍历每个队列，当所有队列皆为空，且没有其他未完成的任务时，程序将退出。

另外，值得注意的是**由Node.js实现的两个队列**位于图片正中，那么他们是什么时候被轮询和执行的呢？大案是**在任意两个阶段之间**。即Node.js会保证在执行LibUV队列的当前阶段后，下一阶段前，执行自身实现队列中的全部回调，保证两个队列都为空，再进入下一阶段。

前文提到Promise Microtasks队列中的回调任务来自Node.js Native Promise而不包含第三方Promise实现如`q`或`BlueBird`，这些库是在ES6提供标准的Promise实现之前的替代品，他们在内部有着不同的实现，默认情况下，`q`基于Next Tick队列而`BlueBird`基于Immediate队列。这可以通过实验简单验证。

这就带来两个问题，其一是定时器可能并不会准时执行，执行器总是会完成前面的任务，直到循环至Timer & Interval队列。Node.js只会保证当执行器循环至此队列时那些到期甚至过期的定时器回调一定会被执行。另一个问题是，如果我们不断通过`process.nextTick`向Next Tick队列添加待执行的回调函数，那么理论上后续的如IO队列会陷入饥饿状态，永远不会执行。此处以实验验证：

{% codeblock "process.nextTick造成饥饿" lang=javascript %}
function addNextTick() {
    process.nextTick(addNextTick);
}
process.nextTick(addNextTick);
setTimeout(() => console.log('never access here.'), 0);
{% endcodeblock %}

执行后程序没有任何输出，与此前设想一致，因此在实际开发中应当避免这种情况。在Node.js的早期版本中曾有对Next Tick队列深度的限制配置，但后续版本中已经因为一些原因移除了此限制。

# 总结
本文简单讨论了Event Loop的真实实现及一小部分细节，限于篇幅，更多详细内容我会在后续文章中继续补全。在本文的最后，给出一幅图片，描述了LibUV在Node.js结构中的位置。

{% asset_img "Node.js结构.png" %}

# 参考资料
[Event Loop and the Big Picture — NodeJS Event Loop Part 1](https://jsblog.insiderattack.net/event-loop-and-the-big-picture-nodejs-event-loop-part-1-1cb67a182810)
