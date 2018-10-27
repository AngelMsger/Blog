---
title: Java并发总结：基础
date: 2018-03-29 21:25:07
tags:
- Java
- Concurrent
categories:
- Java & JVM
thumbnail: "/images/Java并发总结：基础.jpg"
---
最近忙着找工作，好几次被面试官问到并发方面的知识都答的不好，挺尴尬的，这里复习总结一下吧。

# 并发
并发简单来讲就是多个任务同时工作，目的主要是更好的利用多核CPU的性能(含有可能阻塞的任务)及更简单的描述某些任务模型(如仿真)。线程相较进程来讲更加轻量，并且共享进程可见的资源。Java中最基本的多线程知识就不展开说了，首先创建Thread类或实现Runnable接口的对象，然后重写run方法，调用start()启动任务，最后所有线程执行完毕后程序结束。

# Executor
JDK5中关于并发有比较大的变化。几个比较关键的类是Executor，Executors，ExcutorService。Executor是一个接口，包含一个名为execute的方法。顾名思义，接口的实现类在功能上就是能够帮助你执行某个异步任务。ExcutorService也是一个接口，继承自Executor，但追加了一些对异步任务生命周期控制的方法，比如shutdown（停止接受新任务并等待现有任务运行结束）。Executors可以简单的理解为一个工厂类，通过调用静态方法获取不同类型的Executor，主要包含以下几种：

1. CachedThreadPool: 有异步任务需要线程但线程池中没有空余则创建新线程，新线程在任务执行结束后等待复用。
2. FixedThreadPool: 直接创建包含固定数量线程的线程池，新任务到达但线程池内所有线程都不空闲时新任务排队等待。
3. SingleThreadExecutor: 可以理解为单线程任务队列或容量为1的FixedThreadPool。

{% codeblock "示例" lang=java %}
class Foo implements Runnable {
    private static int count = 0;

    @Override
    public void run() {
        System.out.println("bar..." + count++);
    }
}

public class Demo {
    public static void main(String[] args) {
        ExecutorService executorService = Executors.newCachedThreadPool();
        for (int i = 0; i < 4; i++) {
            executorService.execute(new Foo());
        }
        executorService.shutdown();
    }
}
{% endcodeblock %}
{% codeblock "输出结果" lang=java %}
bar...0
bar...3
bar...1
bar...2
{% endcodeblock %}

# Callable与Future
我们可以要求异步任务带有返回结果，这时我们需要实现泛型接口Callable，重写call方法，并交给ExecutorService的submit方法执行，此方法会返回一个Future对象。一个Future对象描述一个异步任务的执行情况，比如我们可以通过isDone方法获取是否完成，通过get方法获取异步任务的返回值等。如果我们尝试获取返回值但异步任务还未结束，则会引起阻塞。

{% codeblock "示例" lang=java %}
class Foo implements Callable<String> {
    private static int count = 0;

    @Override
    public String call() throws Exception {
        return "bar..." + count++;
    }
}

public class Demo {
    public static void main(String[] args) {
        List<Future<String>> futures = new LinkedList<>();
        ExecutorService executorService = Executors.newCachedThreadPool();
        for (int i = 0; i < 4; i++) {
            futures.add(executorService.submit(new Foo()));
        }
        try {
            for (Future<String> future: futures){
                System.out.println(future.get());
            }
        } catch (InterruptedException | ExecutionException e) {
            e.printStackTrace();
        } finally {
            executorService.shutdown();
        }
    }
}
{% endcodeblock %}
输出结果：
{% codeblock "输出结果" %}
bar...0
bar...1
bar...2
bar...3
{% endcodeblock %}

# 优先级和后台线程
我们可以通过Thread类的静态方法currentThread获取当前线程实例，实例有setPriority方法可以设置线程优先级。一般很少手动改变线程的优先级，这种改变也仅仅是调整线程被调度的频率。
在线程启动之前，我们可以调用线程实例的setDaemon方法把线程设置为后台线程。后台线程和非后台线程的区别在于，进程会等待所有非后台线程执行结束后退出，无论是否还存在正在执行的后台线程。
生成Executor的构造方法接受一个参数，该参数为一个实现了ThreadFactory接口的对象，此接口包含名为newThreaed的方法，为Executor构造Thread实例。下面是一个后台线程池示例：
{% codeblock "示例" lang=java %}
class Foo implements Runnable {
    private static int count = 0;

    @Override
    public void run() {
        try {
            System.out.println("bar..." + count++);
        }
        finally {
            System.out.println("this should always run?");
        }
    }
}

public class Demo {
    public static void main(String[] args) {
        ExecutorService executorService = Executors.newFixedThreadPool(4, r -> {
            Thread thread = new Thread(r);
            thread.setDaemon(true);
            return thread;
        });
        for (int i = 0; i < 4; i++) {
            executorService.execute(new Foo());
        }
        executorService.shutdown();
    }
}
{% endcodeblock %}
在我的电脑上，程序没有任何输出就结束了，**甚至finaly块中的代码也没有被执行**，因为所有非后台进程随着main函数的结束而结束，因此程序退出而并没有等待后台线程执行。此外，**如果一个线程是后台线程，那么它创建的其他线程也将被自动设置为后台线程**。

# 捕获异常
线程中产生的异常如果逃逸，不会被其他线程捕获。
{% codeblock "示例" lang=java %}
class Foo implements Runnable {
    @Override
    public void run() {
        throw new RuntimeException("error here...");
    }
}

public class Demo {
    public static void main(String[] args) {
        try {
            new Thread(new Foo()).start();
        }
        catch (RuntimeException e) {
            System.out.println("catch error at main thread: " + e.getMessage());
        }
    }
}
{% endcodeblock %}
输出结果：
{% codeblock "输出结果" %}
Exception in thread "Thread-0" java.lang.RuntimeException: error here...
	at Foo.run(Demo.java:5)
	at java.base/java.lang.Thread.run(Thread.java:844)
{% endcodeblock %}
如果需要捕获逃逸的异常，可以利用Thread实例的setUncaughtExceptionHandler方法或类的setDefaultUncaughtExceptionHandler静态方法。

# 资源共享与同步
资源共享与同步通常才是并发问题中的真正难点，也是面试中的高频考点。Java中很多操作不保证原子性和线程安全，包括某些数据结构元素变动，甚至自增(++)等。解决并发问题最简单直接的想法就是加锁，对于那些关联到共享资源的方法，同一时间只有拿到锁的那一个线程可以执行，其他线程即使得到调度也必须等待此线程释放锁后才能进入。

## synchronized关键字
Java提供**synchronized**关键字实现上述功能。

### 函数同步
{% codeblock "示例" lang=java %}
class Foo {
    public synchronized void doSomething() throws InterruptedException {
        System.out.println("do something...");
        TimeUnit.SECONDS.sleep(4);
        System.out.println("something done.");
    }

    public synchronized void doSomethingElse() throws InterruptedException {
        System.out.println("do something else...");
        TimeUnit.SECONDS.sleep(4);
        System.out.println("something else done.");
    }
}

public class Demo {
    public static void main(String[] args) {
        final Foo foo = new Foo();
        new Thread() {
            @Override
            public void run() {
                try {
                    foo.doSomething();
                } catch (InterruptedException e) {
                    e.printStackTrace();
                }
            }
        }.start();
        new Thread() {
            @Override
            public void run() {
                try {
                    foo.doSomethingElse();
                } catch (InterruptedException e) {
                    e.printStackTrace();
                }
            }
        }.start();
    }
}
{% endcodeblock %}
输出结果：
{% codeblock "输出结果" %}
do something...
something done.
do something else...
something else done.
{% endcodeblock %}
可以看出此情况下synchronized关键字以对象为单位，限制了对资源的并发访问，在第一个线程访问doSomething方法时，另一个线程不仅不能访问doSomething，同样不能访问doSomethingElse。synchronized也可以加在静态方法上，此时标志位位于Class类的实例上，控制对静态变量的访问。

### 临界区
有的时候我们只是需要防止多个线程同时访问某一部分代码而非整个方法，这时我们为synchronized指定一个标志位对象。
{% codeblock "示例" lang=java %}
synchronized(syncObject) {
    // this code can be accessed by only one task at a time
}
{% endcodeblock %}

## Lock对象
Lock对象也是JDK5之后在java.util.concurrent类库中提供的，我们显式的在代码中调用其lock和unlock方法来实现互斥操作。这通常需要写更多代码，更容易出错，但更灵活。比如利用Lock，我们可以实现尝试获取锁(允许失败)，或者获取锁指定时间后释放。

# 可视性和原子性
由于效率问题，变量的操作结果通常会被缓存在寄存器而非直接写入主存。因此，即使本身符合原子性的操作，也并非一定会被另一个进程拿到正确的值，这就是可视性问题。synchronized关键字修饰的方法本身会将结果写回主存，不存在可见性问题。对于非synchronized方法内的操作，如果希望对一个变量的操作可以立刻被其他线程读取，可用**volatile**修饰。

# 原子类
JDK5引入了如AtomicInteger，AtomicLong等特殊的原子性变量类，并提供一些满足原子性的操作，在涉及性能调优时很有用处。

# ThreadLocal
防止任务在共享资源上产生冲突的另一种方式是根除对变量的共享。ThreadLocal是一种自动化机制，可以为使用相同变量(常见如类静态变量)的不同线程创建不同存储。每个线程持有自己的变量，因此不存在共享，也就不会发生资源共享中的各种问题。

# 终止任务
Thread实例提供的suspend来阻塞线程，stop来停止线程都已将被废止了，因为他们可能带来微妙而难以发现的问题，比如不释放锁，允许访问受损状态的对象等。我们用以下方式来更加优雅和安全的结束线程。

1. 手动设置标志位。
2. 调用线程实例的interrupt方法设置中断状态，阻塞的线程如果被设置中断状态则会抛出InterruptedException异常。抛出异常或调用线程的interrupted方法后中断状态恢复。
3. 利用ExecutorService实例的shutdownNow方法控制其管理的所有线程。
4. 通过ExecutorService实例的submit方法执行线程后利用其返回的Future对象控制某个具体线程。

IO阻塞和synchronized同步块是无法中断的，但ReentrantLock造成的阻塞可以被中断。

# 线程交互与协作
正在执行的线程可以主动让出控制权，如果你在代码中显式调用了另一个线程实例的join方法，当前线程就会挂起，直到那个线程执行结束。我们可以调用线程实例的interrupt方法。
{% codeblock "示例" lang=java %}
class Sleeper implements Runnable {
    private String name;

    public Sleeper(String name) {
        this.name = name;
    }

    @Override
    public void run() {
        try {
            System.out.println(name + " is sleeping...");
            TimeUnit.SECONDS.sleep(4);
        } catch (InterruptedException e) {
            System.out.println(name + " is interrupted.");
        }
    }
}

class Joiner implements Runnable {
    private String name;
    private Thread sleeperThread;

    public Joiner(String name, Thread sleeperThread) {
        this.name = name;
        this.sleeperThread = sleeperThread;
    }

    @Override
    public void run() {
        try {
            System.out.println(name + " now join the sleeper...");
            sleeperThread.join();
            System.out.println(name + " back.");
        } catch (InterruptedException e) {
            System.out.println(name + " is interrupted.");
        }
    }
}

public class Demo {
    public static void main(String[] args) {
        Thread sleeper1 = new Thread(new Sleeper("sleeper1"));
        Thread sleeper2 = new Thread(new Sleeper("sleeper2"));
        Joiner joiner1 = new Joiner("joiner1", sleeper1);
        Joiner joiner2 = new Joiner("joiner2", sleeper2);

        sleeper1.start();
        sleeper2.start();

        new Thread(joiner1).start();
        new Thread(joiner2).start();
    }
}
{% endcodeblock %}
输出结果：
{% codeblock "输出结果" %}
joiner2 now join the sleeper...
joiner1 now join the sleeper...
sleeper2 is sleeping...
sleeper1 is sleeping...
joiner2 back.
joiner1 back.
{% endcodeblock %}
sleep和yeild会使当前线程让出CPU占用权，但不会释放对象锁。而wait和notify/notifyAll则会在让出CPU占用权的同时释放当前锁结构，以授权其他线程有机会产生期待的变化。

# 总结
本文主要总结了Java中关于并发的基础部分。下一篇文章中我会针对JDK5后新加入的一些并发类库和特性进行总结。
