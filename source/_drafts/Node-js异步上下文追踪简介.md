---
title: Node.js异步上下文追踪简介
date: 2021-10-21 20:48:56
tags:
---

[Node.js](https://nodejs.org/)是一个执行模型相对特殊的编程语言, 这主要由于其构建在[LibUV](https://libuv.org/)提供的EventLoop之上, 关于其原理和队列调度的更多细节我曾在[另一篇文章里](https://blog.angelmsger.com/%E6%8E%A2%E7%B4%A2Node-js%E5%8E%9F%E7%90%86/)简单介绍过. 这篇文章主要介绍在此基础上Node.js提供的异步上下文追踪能力.

对于一些复杂的业务场景, 我们需要在代码深处获取一个外层的变量, 除了破坏原有代码结构, 层层传递参数以外, 一种更优雅的方式是内层业务直接通过上下文变量获取. 这种上下文变量形如全局变量, 但与某种特定的生命周期绑定, 如一个Http请求, 并且在该周期内不会与其他线程产生冲突. 上下文中维护的变量因业务和维度而不同, 通常是对该生命周期所处环境的一种抽象, 比如当次请求关联的用户, 权限视图, 时区和语言偏好等. 这样业务代码只需传递业务相关参数而无需反复传递环境相关参数.

在传统的多线程编程模型下, 上下文变量可以通过ThreadLocal轻松构建. 如传统的Serverlet, 由于每个请求都在单个业务线程上执行, 因此与Http请求相同生命周期的实例对象可以在请求开始时挂载在ThreadLocal中, 在该作用域中的任意位置读写都不会与其他请求冲突.

而Node.js的事件循环或更广泛的Reactor模型, 使得所有业务代码都在单个执行线程上运行, 请求1因数据库I/O挂起之后线程将转而运行已就绪的请求2的业务代码, 并在未来某个不确定的数据库就绪时间回归, 因此ThreadLocal显然不再满足这种场景的需要.

# Async hooks

`async_hooks`是Node.js提供追踪异步资源的模块. 官方文档对异步资源的描述是一个与回调函数关联的对象, 这是比较抽象的, 更具体的说, 此处的回调函数并非我们代码形式上的回调函数, 而是EventLoop视角的回调函数, 或理解为LibUV队列中的事件, 当LibUV通过I/O多路复用, 线程池完成等待条件, 并将事件和结果交还到V8执行器的时候, 我们视为发生了一次回调. 上述过程也即一个异步资源的生命周期. 为了更加清晰的理解异步资源, 我将之前文章中的图搬过来:

![EventLoop](../images/Node-js%E5%BC%82%E6%AD%A5%E4%B8%8A%E4%B8%8B%E6%96%87%E8%BF%BD%E8%B8%AA%E7%AE%80%E4%BB%8B/EventLoop.png)

通过上述简介, 你自然可以理解官网中对异步资源其他特性的描述, 比如异步资源可能回调一次, 也可能会回调多次, 这是由于某些动作可能会对应多个队列事件, 如监听TCP端口连接的建立, 也有动作只会产生一个队列事件. 如打开磁盘文件. 再比如如果使用了`worker_threads`中的`Worker`类实例, 则不同实例产生的异步资源ID相互独立, 这是由于不同的`Worker`本质上对应着不同的EventLoop. 下面通过一段代码简单演示`async_hooks`提供的API的基本功能:

```nodejs
const async_hooks = require('async_hooks');
const { createHook, executionAsyncId, triggerAsyncId } = async_hooks;
const fs = require('fs');
const { createServer } = require('net');

/**
 * 由于 console.log 本质也是异步事件, 如果在 async_hooks 事件回调中使用,
 * 会造成无限递归, 因此我们编写同步版本以实现输出至 stdout.
 * @param args -  打印参数.
 */
function println(...args) {
    fs.writeFileSync(1, args.join('') + '\n');
}

/**
 * 格式化并输出.
 * @param event - 标识.
 * @param eid - executionAsyncId.
 * @param tid - triggerAsyncId.
 */
function printWithFormat(event, eid, tid) {
    eid = `${ eid ? eid : executionAsyncId() }`;
    tid = `${ tid ? tid : triggerAsyncId() }`;
    const eventWithSpace = `${ event }${ ' '.repeat(24 - event.length) }`;
    const eidWithSpace = `${ eid }${ ' '.repeat(16 - eid.length) }`;
    const tidWithSpace = `${ tid }${ ' '.repeat(16 - tid.length) }`;
    println(`${ eventWithSpace }${ eidWithSpace }${ tidWithSpace }`);
}

// 打印表头.
printWithFormat('event', 'execution id', 'trigger by');

// 注册回调函数并启用.
createHook({
    /**
     * 异步资源初始化回调函数.
     * @param asyncId - 异步资源 Id.
     * @param type - 异步资源类型.
     * @param triggerAsyncId - triggerAsyncId.
     * @param resource - 状态不确定的异步资源.
     */
    init: (asyncId, type, triggerAsyncId, resource) => {
        printWithFormat(`init ${ type }(${ asyncId })`, null, triggerAsyncId);
    },
    /**
     * 异步资源回调执行前回调函数.
     * @param asyncId - 异步资源 Id.
     */
    before: (asyncId) => {
        printWithFormat(`before ${ asyncId }`);
    },
    /**
     * 异步资源回调执行后回调函数.
     * @param asyncId - 异步资源 Id.
     */
    after: (asyncId) => {
        printWithFormat(`after ${ asyncId }`);
    },
    /**
     * 异步资源销毁后回调函数.
     * @param asyncId - 异步资源 Id.
     */
    destroy: (asyncId) => {
        printWithFormat(`destroy ${ asyncId }`);
    },
    /**
     * Promise 构造器中的 resolve 函数被调用后回调函数.
     * @param asyncId - 异步资源 Id.
     */
    promiseResolve: (asyncId) => {
        printWithFormat(`promise resolve ${ asyncId }`);
    }
})
// AsyncHook 实例需要显式调用 enable 方法以启用.
.enable();

// 创建 TCP 服务模拟监听异步事件.
createServer(() => {
    printWithFormat('connecting...');
    fs.exists(process.argv[1], () => {
        printWithFormat('fs...');
    });
})
.listen(8080, () => {
    printWithFormat('listening...');
});
```

输出如下:

```
// 启动
event                   execution id    trigger by
init TCPSERVERWRAP(2)   1               1						// 初始化对 TCP 端口的监听
init TickObject(3)      1               2						// listen 的回调包装在 process.nextTick 中
before 3                3               2						// TickObject 即将通过回调执行用户代码
listening...            3               2						// 用户代码执行中
after 3                 3               2						// 用户代码执行完毕, 回调结束
// 客户端连接
init TCPWRAP(4)         0               2						// TCP 连接异步资源初始化, execute by 0 由于该过程发生在 C++ 代码中
before 2                2               1						// TCPWRAP 即将通过回调执行用户代码
connecting...           2               1						// 用户代码执行中
init FSREQCALLBACK(5)   2               2						// 用户访问本次磁盘文件, FSREQCALLBACK 初始化
after 2                 2               1						// 由 TCPWRAP 产生的回调执行完毕
destroy 3               0               0						// TicketObject 被销毁
before 5                5               2						// 文件准备就绪, 即将通过回调执行用户代码
fs...                   5               2						// 用户代码执行中
after 5                 5               2						// 由 FSREQCALLBACK 产生的回调执行完毕
destroy 5               0               0						// FSREQCALLBACK 被销毁
// ...
```

本质上, Node.js在多个队列中相互关联的事件模拟了一个调用栈并维护这种状态, 并将异步资源的生命周期通过回调函数的方式在`async_hooks`模块中进行暴露. 我们可以通过另一幅图展示两种上下文构建方式及Node.js对调用栈的模拟:

![异步上下文追踪](../images/Node-js%E5%BC%82%E6%AD%A5%E4%B8%8A%E4%B8%8B%E6%96%87%E8%BF%BD%E8%B8%AA%E7%AE%80%E4%BB%8B/%E5%BC%82%E6%AD%A5%E4%B8%8A%E4%B8%8B%E6%96%87%E8%BF%BD%E8%B8%AA.png)

我们编写一个简单的Http服务上下文的例子:

```nodejs
const { createServer } = require('http');
const { executionAsyncId, executionAsyncResource, createHook } = require('async_hooks');

const CONTEXT = Symbol('url');

createHook({
    init: (asyncId, type, triggerAsyncId, resource) => {
        const ear = executionAsyncResource();
        if (ear) {
          resource[CONTEXT] = ear[CONTEXT];
        }
    }
})
.enable();

createServer((req, res) => {
    // 在当前异步资源中写入.
    executionAsyncResource()[CONTEXT] = { url: req.url };
    // 在另一个异步资源中读取(两个异步资源中间, 执行线程可能已处理其他请求, 但我们写入的上下文却不会被影响).
    setTimeout(() => res.end(JSON.stringify(executionAsyncResource()[CONTEXT])), 100);
})
.listen(3000);
```

# AsyncLocalStorage

如果我们只是想在Web场景下为异步函数提供Http请求生命周期的上下文变量, 其实不必关注`AsyncHook`的具体实现, Node.js提供了其简化封装[`AsyncLocalStorage`](https://nodejs.org/api/async_context.html#class-asynclocalstorage), 使用现有封装可以避免因代码问题造成的内存泄露或性能风险. 我们对刚才的例子进行改写, 如下:

```
const { createServer } = require('http');
const { AsyncLocalStorage } = require('async_hooks');

const CONTEXT = Symbol('url');

const storage = new AsyncLocalStorage();

createServer((req, res) => {
    storage.run({ url: req.url }, () => {
        // 在另一个异步资源中读取(两个异步资源中间, 执行线程可能已处理其他请求).
        const context = storage.getStore();
        setTimeout(() => res.end(JSON.stringify(context)), 100);
    });
})
.listen(3000);
```

