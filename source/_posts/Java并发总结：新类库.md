---
title: Java并发总结：新类库
date: 2018-03-31 21:54:17
tags:
- Java
- Concurrent
categories:
- Java & JVM
thumbnail: "/images/Java并发总结：新类库.jpg"
---
我在{% post_link "Java并发总结：基础" "上一篇文章" %}主要总结了Java中关于并发的一些基础知识，这篇文章重点讨论JDK5之后加入的关于并发方面的新类库和特性。

# CountDownLatch
CountDownLatch被用来同步一个或多个任务。我们可以向CountDownLatch赋一个初值，在这个对象上调用await方法将使线程阻塞，直到CountDownLatch的值为0时恢复。其他线程完成任务时可以调用CountDownLatch实例的countDown方法来减小其值。CountDownLatch被设置为仅触发一次，它不能被重复赋值。
{% codeblock "示例" lang=java %}
class Foo implements Runnable {
    private final CountDownLatch countDownLatch;

    public Foo(CountDownLatch countDownLatch) {
        this.countDownLatch = countDownLatch;
    }

    @Override
    public void run() {
        try {
            System.out.println("awaiting...");
            countDownLatch.await();
            System.out.println("finish.");
        } catch (InterruptedException e) {
            e.printStackTrace();
        }
    }
}

class Bar implements Runnable {
    private final CountDownLatch countDownLatch;

    public Bar(CountDownLatch countDownLatch) {
        this.countDownLatch = countDownLatch;
    }

    @Override
    public void run() {
        System.out.println("doing work...");
        try {
            TimeUnit.SECONDS.sleep(4);
            System.out.println("done.");
            countDownLatch.countDown();

        } catch (InterruptedException e) {
            e.printStackTrace();
        }
    }
}

public class Demo {
    public static void main(String[] args) {
        final int size = 4;
        CountDownLatch countDownLatch = new CountDownLatch(size);
        ExecutorService executorService = Executors.newFixedThreadPool(2 + size);
        for (int i = 0; i < 2; i++) {
            executorService.execute(new Foo(countDownLatch));
        }
        for (int i = 0; i < size; i++) {
            executorService.execute(new Bar(countDownLatch));
        }
        executorService.shutdown();
    }
}
{% endcodeblock %}
输出结果：
{% codeblock "输出结果" %}
awaiting...
awaiting...
doing work...
doing work...
doing work...
doing work...
done.
done.
done.
done.
finish.
finish.
{% endcodeblock %}

# CyclicBarrier
CyclicBarrier适用于多个任务并行执行，并在下一个步骤前等待直至全部完成。这有点类似CountDownLatch，但CyclicBarrier可以重复多次使用。此外，CyclicBarrier的构造函数接受一个实现Runnable接口的类实例作为计数值到达0时的回调函数。下面这段代码模拟了一次赛马比赛。
{% codeblock "示例" lang=java %}
class Horse implements Runnable {
    private static int counter = 0;
    private final int id = counter++;

    private int strides = 0;

    private static Random random = new Random(47);
    private static CyclicBarrier cyclicBarrier;

    public Horse(CyclicBarrier cyclicBarrier) {
        Horse.cyclicBarrier = cyclicBarrier;
    }

    public int getId() {
        return id;
    }

    public synchronized int getStrides() {
        return strides;
    }

    public String tracks() {
        StringBuilder stringBuilder = new StringBuilder();
        for (int i = 0; i < getStrides(); i++) {
            stringBuilder.append('*');
        }
        stringBuilder.append(id);
        return stringBuilder.toString();
    }

    @Override
    public void run() {
        while (!Thread.interrupted()) {
            synchronized (this) {
                strides += random.nextInt(3);
            }
            try {
                cyclicBarrier.await();
            } catch (InterruptedException | BrokenBarrierException e) {
                e.printStackTrace();
            }
        }
    }
}

public class Demo {
    public static void main(String[] args) {
        final int HORSES = 7, FINISH = 74;
        List<Horse> horses = new ArrayList<>();

        ExecutorService executorService = Executors.newCachedThreadPool();
        CyclicBarrier cyclicBarrier = new CyclicBarrier(HORSES, new Runnable() {
            @Override
            public void run() {
                StringBuilder stringBuilder = new StringBuilder();
                for (int i = 0; i < FINISH; i++) {
                    stringBuilder.append('=');
                }
                System.out.println(stringBuilder);

                for (Horse horse: horses) {
                    System.out.println(horse.tracks());
                }
                for (Horse horse: horses) {
                    if (horse.getStrides() > FINISH) {
                        System.out.println(horse.getId() + " won!");
                        executorService.shutdownNow();
                        return;
                    }
                }
            }
        });

        for (int i = 0; i < HORSES; i++) {
            Horse horse = new Horse(cyclicBarrier);
            horses.add(horse);
            executorService.execute(horse);
        }
    }
}
{% endcodeblock %}
输出结果：
{% codeblock "输出结果" %}
==========================================================================
**0
**1
*2
**3
*4
**5
*6
==========================================================================

...
s
==========================================================================
***************************************************************************0
******************************************************************1
**********************************************************2
**************************************************************3
**************************************************************4
********************************************************************5
******************************************************************6
0 won!
{% endcodeblock %}

# ScheduledExecutor
**ScheduledExecutor**可以实现一定时间后调度任务或以某一频率调度任务。
{% codeblock "示例" lang=java %}
public class Demo {
    public static void main(String[] args) {
        ScheduledThreadPoolExecutor scheduledThreadPoolExecutor = new ScheduledThreadPoolExecutor(4);
        scheduledThreadPoolExecutor.schedule(new Runnable() {
            @Override
            public void run() {
                System.out.println("something running once...");
            }
        }, 4, TimeUnit.SECONDS);
        scheduledThreadPoolExecutor.scheduleAtFixedRate(new Runnable() {
            @Override
            public void run() {
                System.out.println("something running with fixed rate...");
            }
        }, 4, 4, TimeUnit.SECONDS);
        System.out.println("something in main.");
    }
}
{% endcodeblock %}
输出结果：
{% codeblock "示例" lang=java %}
something in main.
something running once...
something running with fixed rate...
something running with fixed rate...
something running with fixed rate...
{% endcodeblock %}

# Exchanger
**Exchanger**适用于生产者，消费者模型，用来在不同任务间交换对象。
{% codeblock "示例" lang=java %}
class Producer implements Runnable {
    private Exchanger<List<Integer>> exchanger;
    private List<Integer> list;

    public Producer(Exchanger<List<Integer>> exchanger, List<Integer> list) {
        this.exchanger = exchanger;
        this.list = list;
    }

    @Override
    public void run() {
        while (!Thread.interrupted()) {
            for (int i = 0; i < 8; i++) {
                System.out.println(String.format("[%s] add %d to list...list size: %d",
                        Thread.currentThread().getId(), i, list.size()));
                list.add(i);
            }
            try {
                list = exchanger.exchange(list);
            } catch (InterruptedException e) {
                e.printStackTrace();
            }
        }
    }
}

class Consumer implements Runnable {
    private Exchanger<List<Integer>> exchanger;
    private List<Integer> list;

    public Consumer(Exchanger<List<Integer>> exchanger, List<Integer> list) {
        this.exchanger = exchanger;
        this.list = list;
    }

    @Override
    public void run() {
        while (!Thread.interrupted()) {
            try {
                list = exchanger.exchange(list);
            } catch (InterruptedException e) {
                e.printStackTrace();
            }
            for (Integer i: list) {
                System.out.println(String.format("[%s] fetch %d..., list size: %d",
                        Thread.currentThread().getId(), i, list.size()));
                list.remove(i);
            }
        }
    }
}

public class Demo {
    public static void main(String[] args) throws InterruptedException {
        List<Integer> pruducerList = new CopyOnWriteArrayList<>();
        List<Integer> consumerList = new CopyOnWriteArrayList<>();
        Exchanger<List<Integer>> exchanger = new Exchanger<>();
        ExecutorService executorService = Executors.newCachedThreadPool();
        executorService.execute(new Producer(exchanger, pruducerList));
        executorService.execute(new Consumer(exchanger, consumerList));
        TimeUnit.SECONDS.sleep(4);
        executorService.shutdownNow();
    }
}
{% endcodeblock %}
输出结果：
{% codeblock "输出结果" lang=java %}
...

[13] add 5 to list...list size: 5
[13] add 6 to list...list size: 6
[13] add 7 to list...list size: 7
[13] add 0 to list...list size: 0
[13] add 1 to list...list size: 1
[13] add 2 to list...list size: 2
[13] add 3 to list...list size: 3
[13] add 4 to list...list size: 4
[14] fetch 0..., list size: 8
[14] fetch 1..., list size: 7
[14] fetch 2..., list size: 6
[14] fetch 3..., list size: 5
[14] fetch 4..., list size: 4
[14] fetch 5..., list size: 3
[14] fetch 6..., list size: 2
[14] fetch 7..., list size: 1

...
{% endcodeblock %}

# 性能调优
JDK5为我们提供的新类库为我们提升并发程序的性能提供了更多选择，我们可以用CopyOnWriteArrayList，ConcurrentHashMap等为特定并发情景涉及的容器代替传统的同步容器，也可以使用基于Atomic类的compareAndSet方法实现乐观锁，在读多写少的情景中使用基于ReadWriteLock实现读写锁分离。但这些都不意味着使用新类库组件一定能带来更好的性能，实际上效果如何还是要有测试结果为准。
