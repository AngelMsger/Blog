---
title: Python抽象语法树解析入门
date: 2021-09-03 11:23:00
tags:
- Python
- AST
categories:
- Python
thumbnail: "/images/banner/Python抽象语法树解析入门.jpg"
typora-root-url: ../../source/
---

Python提供的[ast](https://docs.python.org/3.11/library/ast.html)模块能够帮助用户将Python源代码解析为抽象语法树.

```python
import ast

# 方法 1
with open('main.py') as f:
    t = ast.parse(f.read())

# 方法 2
with open('debugger.py') as f:
    t = compile(f.read(), f.name, 'exec', ast.PyCF_ONLY_AST)
```

解析出的抽象语法树是由`ast.AST`的子类实例组成的树状结构, 这些子类包括如模块导入, 变量赋值, 循环和函数调用等, 具体列表根据Python版本支持的语法不同存在差异, 可以CPython解释器的[ASDL源代码](https://github.com/python/cpython/blob/main/Parser/Python.asdl)查看最新定义.

# 树节点

`ast.AST`是抽象语法树节点实例的基类, 就CPython解释器而言, 继承体系中的类均为C代码实现并在Python代码中重新导出. 我们不关注其实现细节, 只通过一段代码来了解这棵树的大致结构:

```python
import ast

code = """
import platform

print(f'hello {platform.system()}')
"""

# 解析为抽象语法树
tree = ast.parse(code)
# 打印树状结构
print(ast.dump(tree, indent=4))
```

这里我们解析了一段简短的Python源代码, 该代码导入了内置的`platform`模块并调用内置函数`print`打印了由系统名称组装的字符串. 通过前文提及的工具方法解析该代码片段得到抽象语法树, 并通过`ast.dump`方法将其转换为易于阅读的字符串, 输出结果如下:

```python
Module(
    body=[
        Import(
            names=[
                alias(name='platform')]),
        Expr(
            value=Call(
                func=Name(id='print', ctx=Load()),
                args=[
                    JoinedStr(
                        values=[
                            Constant(value='hello '),
                            FormattedValue(
                                value=Call(
                                    func=Attribute(
                                        value=Name(id='platform', ctx=Load()),
                                        attr='system',
                                        ctx=Load()),
                                    args=[],
                                    keywords=[]),
                                conversion=-1)])],
                keywords=[]))],
    type_ignores=[])
```

可以看到, 树状结构基本与被解析的代码的基本对应. 其中如`Module`, `Import`和`Expr`就是树的节点, 每个节点又包含一些属性, 如上层`Call`节点包括了函数调用的函数名`func=Name(id='print', ...)`和调用参数`args=[JoinedStr(...)]`. 通过Debug, 能够获得这棵树更多的细节:

![AST_Debug](/images/Python%E6%8A%BD%E8%B1%A1%E8%AF%AD%E6%B3%95%E6%A0%91%E8%A7%A3%E6%9E%90%E5%85%A5%E9%97%A8/AST_Debug.png)

实例的属性主要分为两类, 也即对应节点的两个受保护属性中存储的键名:

* `_attributes`: 继承自`ast.AST`, 所有子类均包含:

  * `lineno`: 起始行号
  * `col_offset`: 起始行列偏移
  * `end_lineno`: 结束行号
  * `end_col_offset`: 结束行列偏移

  这些属性标识出该节点在原始代码中的起止位置, 区间遵循左闭右开, 因此可以直接作为Python数组切片的参数, 如`source_line[node.col_offset : node.end_col_offset]`.

* `_fields`: 不同类型节点所包含的子节点属性键, 比如对于`Call`(函数调用)类, 其属性如下:

  * `func`: 函数名
  * `args`: 函数参数定位列表
  * `keywords`: 函数关键字参数列表

  `ast.AST`的具体子类列表和这些子类分别具备哪些属性可以直接查阅对应版本[官方文档](https://docs.python.org/3.11/library/ast.html#literals), 数量非常多, 这里就不再列举了.

解析好的语法树可以由重新由内置函数`compile`编译为代码对象并交由内置函数`exec`进行执行:

```python
exec(compile(tree, filename=f.name, mode='exec'))
```

在Python 3.9之前, 如果想将抽象语法树还原回代码字符串, 需要手动根据后文将介绍的一些工具方法遍历树节点或依赖第三方库的封装实现. 而在Python 3,9之后, Python标准库提供了`ast.unparse`工具方法, 效果如下:

```python
code = ast.unparse(tree)
```

可以通过修改抽象语法树中的节点来实现对源码的操作:

```python
import ast

tree = ast.parse('print("hello, world!")')
tree.body[0].value.args[0].value = 'hello, python!'
print(ast.unparse(tree))

# 控制台输出结果: print('hello, python!')
```

抽象语法树不仅可以通过标准库函数解析代码片段生成, 也可以自己直接组装并反向生成Python源代码:

```python
import ast

node = ast.Assign(
    [ast.Name('i')],
    ast.UnaryOp(
        ast.USub(),
        ast.Constant(5, lineno=0, col_offset=0),
        lineno=0, col_offset=0
    ),
    lineno=0, col_offset=0
)
print(ast.unparse(node))

# 控制台输出结果: i = -5
```

# 树的遍历

标准库提供了一些方法来解析和遍历语法树, 如前文已经提及的`ast.parse`, `ast.unparse`. 

此外, 该模块其实还提供了若干方法, 包括修正子树位置的`ast.fix_missing_locations`, 复制节点位置的`ast.copy_location`, 遍历子节点的`ast.iter_child_nodes`和递归遍历子树的`ast.walk`. 

通过这些函数我们可以手写树遍历算法来实现抽象语法树的遍历, 但实际场景中我们的工作常常仅关注树中某些类型的节点. 此时该模块提供的两个工具类非常有用.

## ast.NodeVisitor

`ast.NodeVisitor`是该模块提供的一个基类, 封装了树节点的遍历过程, 用户可以覆写`visit_XXX`方法来读取指定类型的节点, 其中XXX为节点类的名称. 举例如下代码能够打印出指定源代码通过`import`语句导入了哪些包:

```python
import ast

code = """
import os
import sys

print(f'{os.hostname()}({sys.platform})')
"""

tree = ast.parse(code)

class ImportModuleGetter(ast.NodeVisitor):
    def visit_Import(self, node: ast.Import):
        """
        函数名决定该函数只会在遍历到 Import 节点时被调用
        """
        print(node.names[0].name)

ImportModuleGetter().visit(tree)

# 控制台输出结果:
# os
# sys
```

`ast.NodeVisitor`遍历过程中抽象语法树是只读的, 如果在访问函数中修改该树可能会引起未定义的行为. 如果要在遍历过程中调整或替换树节点, 应该使用下文的`ast.NodeTransformer`.

## ast.NodeTransformer

`ast.NodeTransformer`是`ast.NodeVisitor`的子类, 但允许在遍历过程中对抽象语法树进行修改. 举例如下代码将模板字符串替换为字符串常量:

```python
import ast

code = """
import os
import sys

print(f'{os.hostname()}({sys.platform})')
"""

tree = ast.parse(code)

class ImportModuleGetter(ast.NodeTransformer):
    def visit_JoinedStr(self, joined_str: ast.JoinedStr) -> ast.Constant:
        constant = ast.Constant('JoinedStr NOT Support')
        ast.copy_location(constant, joined_str)
        return constant

tree = ImportModuleGetter().visit(tree)
print(ast.unparse(tree))

# 控制台输出结果
# import os
# import sys
# print('JoinedStr NOT Support')
```

修改过程还需注意一些事项:

* 如果修改对象不是叶子节点, 需要手动处理叶子节点或调用父类方法`generic_visit`.
* 需要正确指定替换后节点的代码位置, 或在最后对整颗抽象语法树调用工具方法`ast.fix_missing_location`.

# 结语

一些可视化编程环境允许用户通过拖拽节点来生成自定义逻辑, 其背后就是将节点的组装转化为抽象语法树的构建, 并为用户编译成可执行的代码逻辑.

沙箱环境在执行用户代码前可以对语法书进行检查, 移除如文件读写等敏感操作.

IDE通过对抽象语法树的解析和Python内置的`inspect`反射模块提供代码高亮和跳转. Lint工具也通过相同的方式检查语法错误. 一些工具能够基于语法树结构和注释生成如Grpc传输体的结构定义文件.

不同编程语言的抽象语法树结构类似, 如微软的[这篇文档](https://github.com/microsoft/TypeScript-wiki/blob/main/Using-the-Compiler-API.md)介绍了如何利用TypeScript的编译器将源代码解析为抽象语法树并实现一个简单的Linter.