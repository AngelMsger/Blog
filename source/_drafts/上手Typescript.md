---
title: 上手 TypeScript
tags:
---
# 静态类型检查
TS 并不能说是一种全新的语言, 它只是一套语法规范, 你按这套规范写代码, 然后 tsc 按这套规范检查代码并编译为 JS, 最终依然是 JS 跑在 V8 上. 这有点类似 Kotlin, Scala 和 Groovy 这些和 Java 一样最终编译为 JVM 可识别的字节码的语言. 但与这些语言不同, TS 为人所知不仅仅在于一些语法糖的加入, 而是能够在从 TS 编译到 JS 时做静态的类型检查. 尽管这种静态的类型检查相比强类型语言比如 C++, Java 来说并不严格, 但能从一定程度上规范 Object 的属性, 避免一些低级错误, 也能为 IDE 的自动补全提供更准确的推荐. 但与此同时也势必会造成语法灵活性上一定程度的下降, 不过好在类似于 JVM 语言的通用性, TS 文件中也可以引入 JS, 只不过这时可能就会需要写一些强制类型定义来让编译器不报错. 关于这些得失是否值得就见仁见智了.
这就是一段 TS 代码:
{% codeblock "“ lang=javascript %}
class Student {
    fullName: string;
    constructor(public firstName, public middleInitial, public lastName) {
        this.fullName = firstName + " " + middleInitial + " " + lastName;
    }
}

interface Person {
    firstName: string;
    lastName: string;
}

function greeter(person : Person) {
    return "Hello, " + person.firstName + " " + person.lastName;
}

let user = new Student("Jane", "M.", "User");

document.body.innerHTML = greeter(user);
{% endcodeblock %}
# 类型
TS 中的基础类型包括布尔值(boolean), 数字(number), 字符串(string), 数组(number[], Array<number>), 元组(\[number, string\]), 枚举(enum), Any, Void, Null/Undefined, Never 和 Object. 类型一旦被定义, tsc 在编译时就会做静态检查, 不匹配则会报错. 若没有显式定义, 则会根据右值的类型进行推导.
