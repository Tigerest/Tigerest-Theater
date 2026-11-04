# 3.0.0 待办：中文搜索增强

日期：2026-11-04（Asia/Shanghai）

状态：**排在 3.0.0 做，还没开工。** 开始做 3.0.0 时先看这份。

## 1. 问题

Emby 原生搜索对中文很差：

- 全文索引不给中文分词，一串连续的汉字会被当成一个词，只能从标题开头，或者标点、空格后面开始匹配。比如搜“进击”能找到《进击的巨人》，搜“巨人”就找不到。
- 不支持简繁互通、拼音和首字母，也搜不到别名，比如搜“海贼王”找不到“航海王”。

客户端现在把搜索词原样交给服务器（`SearchTerm`），所以和 Emby 网页版一样差。已知的调用点：

- Windows、Mac、Android、iPad 共用的网页脚本：Emby 网页里的搜索页（要接管它发出的搜索请求），还有 `native/watchTogether.js` 里一起看的选片搜索。
- Apple TV：`apple/Core/Sources/AppleCore/Emby/EmbyClient.swift` 的列表搜索。

开工时再把其他调用点全面排查一遍。

## 2. 为什么不改服务器

服务器插件“神医助手”（StrmAssistant）的“中文搜索增强”能解决这个问题，但我们不用它：

- 它会替换 Emby 数据库 `library.db` 里的全文索引表。卸载前如果没有先关掉这个功能并重启，数据库会报 `no such tokenizer: simple`，扫库和修改媒体库都会失败。Emby 官方遇到这种情况，会建议删掉数据目录从头来。
- 免费版只支持 Emby 4.8.5.0–4.8.11.0，更新的版本要用付费的 PRO 版。大河服务器的版本不在免费版的支持范围内。
- 它只对装了插件的服务器有效，自建服务器的用户用不上。

## 3. 方案

### 3.1 所有用户：客户端本地搜索

大河服务器和自建 Emby 都能用，服务器不用装任何东西。

1. 登录后在后台分页拉取本人能看到的电影、剧集和合集列表：请求 `/Users/{userId}/Items`，参数为 `Recursive=true`、`IncludeItemTypes=Movie,Series,BoxSet`、`Fields=OriginalTitle,ProductionYear`、`EnableImages=false`、`EnableUserData=false`，每页几千条。用的是用户自己的登录，所以只拿得到他有权限看的片。
2. 列表存成本地缓存，启动时先读缓存。之后只拉新增和改过的条目；定期核对一次条目总数，对不上就全量重拉。
3. 本地匹配：标题任意位置都能匹配，繁体转成简体，支持全拼和首字母，忽略标点、全半角和大小写。原名也参与匹配。
4. 命中的条目按 `Ids` 向 Emby 取海报、观看状态等详情。已经删除的条目 Emby 不会返回，顺手从缓存里去掉。
5. 同时请求 Emby 原生搜索，两边结果合并去重。列表还没下载完或者出错时，只显示原生结果。
6. 片库到 10 万部这个级别时，索引改用“所有片名拼成一个长字符串，再配一张偏移表”的写法，比每部片存一个对象省很多内存（见第 4 节）。

### 3.2 大河服务器用户：后端补别名

社区后端再提供一张别名表，比如 TMDB 上的其他译名、管理员手动填的俗称，这样搜“海贼王”也能找到“航海王”。接口沿用评论服务现有的身份校验（`X-Emby-Token`、`X-Emby-Server-Id`、`X-Emby-User-Id`），只认大河服务器。后端源码在独立的私有仓库。

## 4. 测速（2026-11-04）

用随机生成的中日英混合片名模拟片库，只算电影、剧集和合集，在 i9-14900K 上用 Node 24 跑：

| 片库规模 | 列表大小 | 解析和建索引 | 每次搜索 | 内存 |
| --- | --- | --- | --- | --- |
| 1 万部 | 2.4 MB | 0.03 秒 | 0.3–1 毫秒 | 1–8 MB |
| 3 万部 | 7.2 MB | 0.09 秒 | 1–3.5 毫秒 | 3–25 MB |
| 10 万部 | 24 MB | 0.25 秒 | 3–11 毫秒 | 11–83 MB |

- 后两列的范围，较小的一头是省内存写法，较大的一头是每部一个对象的普通写法。
- 每部片的数据约 240 字节。大河服务器的 Emby 连 15 KB 的网页文件都不压缩，即使请求声明支持压缩也原样返回，接口数据估计也一样，开工时用第 5 节的脚本确认。按不压缩算，10 万部的列表在局域网要 0.6 秒，外网上行 50M 要 3.9 秒、20M 要 9.6 秒、5M 要 39 秒。如果前面套了开启压缩的反向代理，数据量约为五分之一。
- 本地缓存：3 万部约 2 MB，10 万部约 7 MB。在这台电脑上读缓存并建好索引要 0.06–0.2 秒。
- 片名是随机生成的，真实的 Emby 数据每条可能多两三成。

## 5. 开工时要确认的事

1. **服务器耗时和是否压缩。** 在电脑浏览器里打开 Emby 网页版并登录，按 F12 打开控制台，粘贴下面这段。它只读数据，不改任何东西。在局域网跑，“等服务器”那一项基本就是服务器生成列表的时间；在外网跑，总耗时就接近外地用户第一次下载要等的时间。

   ```js
   (async () => {
     const api = window.ApiClient, user = api.getCurrentUserId(), page = 5000;
     let start = 0, count = 0, bytes = 0, wait = 0, enc = '';
     const t0 = performance.now();
     for (;;) {
       const url = api.getUrl(`Users/${user}/Items`, {
         Recursive: true, IncludeItemTypes: 'Movie,Series,BoxSet', Fields: 'OriginalTitle,ProductionYear',
         EnableImages: false, EnableUserData: false, EnableTotalRecordCount: false,
         SortBy: 'SortName', StartIndex: start, Limit: page });
       const t = performance.now();
       const res = await fetch(url, { headers: { 'X-Emby-Token': api.accessToken() } });
       wait += performance.now() - t;
       enc = res.headers.get('content-encoding') || '无';
       const text = await res.text();
       const n = JSON.parse(text).Items.length;
       count += n; bytes += new Blob([text]).size; start += n;
       if (n < page) break;
     }
     console.log(`共 ${count} 部，${(bytes / 1e6).toFixed(1)} MB，压缩：${enc}，总耗时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒，其中等服务器 ${(wait / 1000).toFixed(1)} 秒`);
   })();
   ```

2. **手机和电视盒子上的速度。** 这次没有测。按电视盒子比 i9 慢 10–15 倍粗估，10 万部建索引要 3–5 秒（在后台做，只做一次），每次搜索几十毫秒。
3. **拼音和繁简转换用什么数据。** 要处理多音字，比如“重庆”“长安”；首字母匹配可以把多音字的几种读法都收进索引。
4. **Jellyfin 服务器要不要一起接入。** 客户端已经支持 Jellyfin。
5. **共用网页脚本怎么接管 Emby 网页搜索页的请求。**

## 6. 参考

- [神医助手 Wiki 首页（安装、卸载、支持的版本）](https://github.com/sjtuross/StrmAssistant/wiki)
- [神医助手 Wiki：中文搜索增强（原理、启用、关闭、手工恢复）](https://github.com/sjtuross/StrmAssistant/wiki/%E4%B8%AD%E6%96%87%E6%90%9C%E7%B4%A2%E5%A2%9E%E5%BC%BA)
- [Emby 论坛：卸载插件后报 “no such tokenizer: simple” 的案例](https://emby.media/community/topic/137846-emby-server/)
- [Emby 论坛：请求支持中文模糊搜索](https://emby.media/community/topic/108466-%E5%8A%9F%E8%83%BD%E8%AF%B7%E6%B1%82%E6%90%9C%E7%B4%A2%E5%AE%9E%E7%8E%B0%E6%A8%A1%E7%B3%8A%E6%90%9C%E7%B4%A2-upgrade-to-fuzzy-search-engine)
