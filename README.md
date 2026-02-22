基于html+腾讯sdk开发的m3u8在线播放器，实现mp4、m3u8/hls格式视频在线播放

[English version](https://github.com/geeeeeeeek/m3u8player/blob/main/Readme-en.md)


## 效果预览

https://m3u8player.org


## 部署步骤

1.申请云播SDK的licenseUrl，申请地址是 https://console.cloud.tencent.com/vcube/web?tab=player

2.将申请后的licenseUrl填到script的licenseUrl中

3.将目录下所有文件复制到服务器即可。



访问入口是index.html

## 本地启动（含 M3U8 转 MP4 后端转码）

当前仓库已增加 `server.js`，用于提供静态页面和 `/api/convert` 转码接口。

1. 安装 ffmpeg（必须）
2. 在项目根目录执行：

```bash
node server.js
```

3. 打开 `http://localhost:8080/m3u8_to_mp4.html`


## 视频教学

https://youtu.be/zSuEPMbgaNU?si=bpg3kuY8tuOfrue7


## 参考效果

- [m3u8player](https://m3u8player-cm4.pages.dev/)

- [vercel-alpha](https://m3u8player-alpha.vercel.app/)

- [Reprodutor M3U8](https://m3u8player.org/pt/)

- [m3u8 player online](https://m3u8player.org/en/)

- [m3u8 to mp4](https://m3u8player.org/en/m3u8_to_mp4/)


