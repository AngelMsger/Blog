---
title: 使用DLib快速实现人脸聚类
date: 2018-06-28 23:06:03
tags:
- DLib
- CV
- Python
- AI
categories:
- CV
thumbnail: "/images/使用DLib快速实现人脸聚类.jpg"
---

毕业了，想整理下四年来拍的照片，琢磨着自己动手写个小工具。前段时间一直想继续钻研下深度学习的，后来因为毕业期间一大堆烦心事也就不了了之了，这次干脆把自己手机里的照片聚下类，再拿聚类结果去训练CNN模型得了，两个一起学，省事。

# DLib
现在很多新兴的东西听着感觉很难的样子，不过细看之下一般核心原理都很朴素。即使完全不想接触原理，也有不少现成的，不同封装程度的库可以直接拿来用，自己写点小玩具很是方便。

[DLib](http://dlib.net/)是一个C++机器学习库，不过也提供了Python接口，而且封装程度很高，因此不需要使用者有比较丰富的背景知识。我们接下来讨论如何利用这个库实现一个简单的人脸聚类。我本来想用C++来写的，但是看完官网的示例后感觉用C++写的话一是篇幅会比较大，二是不少精力要放在C++语法上，所以还是拿Python版本的示例来讲了。

# 原理

## 聚类
这里展开讨论数学证明，但是基本原理还是要讲一下的，理解起来其实也比较容易。所谓聚类就是要把相近或者说是相似的个体聚在一起，相较于监督学习中需要事先对训练集中的样本进行标注，聚类是无监督的，我们在聚类执行前可能也没有一个确定的正确答案。

我们在聚类中主要考虑两个问题，样本间的相似度如何评估，以及样本间相似度已知的前提下如何界定是否处于同一类中。对于第一个问题，与我曾在{% post_link "基于协同过滤的推荐系统" "基于协同过滤的推荐系统" %}这篇文章中提到的特征向量间相似度度量的内容类似，常用的手段如欧式距离，修正余弦等。而对第二个问题的不同处理方式，是区分不同聚类算法的主要内容，常见的如分支聚类，每一轮迭代中合并最相似的两个样本，直至全部样本参与聚类，又如K-Means聚类，事先假设最终产生K个分类，并随机采点作为首轮迭代各分类的中心点，所有样本点归于最近邻中心点所在分类，每轮迭代结束时计算各个分类的几何重心作为新的分类中心点参与下一次迭代，直至迭代指定次数或分类趋于稳定。

本文将要讨论的实现采用了名为[Chinese Whisper](https://www.wikiwand.com/en/Chinese_Whispers_(clustering_method))(CW)的聚类算法，其基本原理是以样本特征向量为无向图中的节点，并在相似度大于阈值的节点间构建边，首轮迭代时每个节点在相邻节点中选择相似度最高的节点作为自己的分类，在接下来的每轮迭代中根据所有邻居的分类情况计算权重和重新决定自己的分类，直到达到指定迭代次数或分类趋于稳定。这一算法DLib有相关实现可以直接调用，不需要我们编写代码。

# 代码实现
这里我们结合代码来讲，[这部分代码](https://github.com/AngelMsger/FrankXX/blob/master/face_clustering.py)来自我前文所提的小玩具中关于人脸聚类的一部分，同时也是参考[DLib官方示例](http://dlib.net/face_clustering.py.html)修改而来，官方示例同样完成了利用CW聚类算法实现人脸聚类，不同的是它最终实现的功能是查找频率最高的人脸并裁剪输出，而我修改为了保留聚类结果并全部输出，是否裁剪则由程序参数决定，此外还有一些细节上的修改。

此处我们跳过导入相关包，解析命令函参数等部分，仅展示聚类相关代码：

{% codeblock "人脸聚类" lang=python %}
# 获取人脸检测，关键点检测，人脸识别相关模型
detector = dlib.get_frontal_face_detector()
sp = dlib.shape_predictor(args.predictor_path)
facerec = dlib.face_recognition_model_v1(args.face_rec_model_path)

# 遍历目录下的图片
for f in glob.glob(os.path.join(args.faces_folder_path, "*.jpg")):
    logger.info("Processing file: {}".format(f))
    # 装载图片
    img = dlib.load_rgb_image(f)
    # 检测人脸数量和位置
    faces = detector(img, 1)
    logger.info("Number of faces detected: {}".format(len(faces)))

    # 遍历人脸
    for face in faces:
        # 利用模型检测人脸68个关键点
        shape = sp(img, face)
        # 利用模型将关键点集转化为128维特征向量
        face_descriptor = facerec.compute_face_descriptor(img, shape)
        descriptors.append(face_descriptor)
        images.append((img, shape, f))

# 调用CW聚类算法进行人脸聚类
labels = dlib.chinese_whispers_clustering(descriptors, 0.5)

# 得到标签数量
num_classes = len(set(labels))
logger.info("Number of clusters: {}".format(num_classes))

# 根据标签构造分类字典
clusters = [[] for _ in range(num_classes)]
for i, pair in enumerate(images):
    clusters[labels[i]].append(pair)

# 定义直接复制函数
def copy(option):
    copyfile(option['f'], option['file_path'])

# 定义裁剪存储函数
def save_face_chip(option):
    dlib.save_face_chip(option['img'], option['shape'], option['file_path'], size=150, padding=0.25)

# 根据命令行参数决定处理方式
if args.save_face_chip:
    process = save_face_chip
else:
    process = copy

logger.info("Saving faces in largest cluster to output folder...")
for i, cluster in enumerate(clusters):
    # 对容量大于阈值的分类进行输出，可以去除部分无意义结果
    if len(cluster) > args.cluster_size_threshold:
        cluster_folder_path = os.path.join(args.output_folder_path, str(labels[i]))
        if not os.path.isdir(cluster):
            os.makedirs(cluster_folder_path)
        for j, pair in enumerate(cluster):
            img, shape, f = pair
            process({
                'img': img,
                'shape': shape,
                'file_path': os.path.join(cluster_folder_path, 'face_{}'.format(j)),
                'f': f
            })
{% endcodeblock %}

# 总结
借助DLib，我们通过很少的代码量就可以实现人脸聚类。如果想要进一步提升聚类的准确率，则可以考虑自己训练对应的模型，关于训练模型DLib同样提供了相关API。在了解DLib接口的使用方式的同时，我们也讨论了聚类过程中的一些原理性内容。在下一篇文章中我会展示如何基于本次聚类的结果，利用[Tensorflow](https://www.tensorflow.org/)来训练一个卷积神经网络来识别一张新的图片中的人是谁。