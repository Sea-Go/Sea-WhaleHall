# 皮肤库（src/views/pet/skins/）

桌面宠物的皮肤统一存放地，位于桌宠视图（pet agent）工作目录下。
**一个皮肤 = 一个目录：代码 + 素材 + 清单全部在
`src/views/pet/skins/pet/<id>/` 内**。

## 当前皮肤清单

| 皮肤 id | 类型 | 本目录内容 |
|---|---|---|
| whale 泡泡鲸 | 序列帧 | index.ts + `<clip>.gif`×6 + SKIN.md |
| cat 橘子猫 | 序列帧 | index.ts + `<clip>.gif`×6 + SKIN.md |
| deepseek DeepSeek 娘 | 序列帧 | index.ts + `<clip>.gif`×6（社区源素材）+ SKIN.md |

三个皮肤与运行时完全同构；whale/cat 的 GIF 由矢量绘制源
（scripts/pet-vector-sources.ts）经 render:pet-skins 离线烘焙。

`models/` 只保留 registry.ts（注册表）与 shared.ts（跨皮肤共用件）。

## 目录约定

```
src/views/pet/skins/pet/<skin-id>/index.ts   帧数表/动作映射/色调映射声明
src/views/pet/skins/pet/<skin-id>/SKIN.md    人工管理清单
src/views/pet/skins/pet/<skin-id>/*.gif      动作片段源素材（唯一素材格式）
```
解帧产物直写 dist/views/pet/<id>/（构建生成，不进皮肤库也不进 git）。

- **全部皮肤统一为 GIF 驱动**（`<clip>.gif`，人工可管理、原始素材随库
  留档）；PNG 帧是 `bun run build:views` 经 decode-pet-skins.ts 解帧生成
  的构建产物，直写 dist/（不进皮肤库也不进 git）——人工只管 GIF，不手工
  碰 PNG。
- 帧的投递由构建管线完成：`decode-pet-skins.ts` 解帧直写
  `dist/views/pet/<id>/`，模型代码用相对路径 `<id>/<clip>/f_NN.png`
  运行时按需加载（不进打包器，bun test 环境同样可用）。
- 非素材/非代码文件（设计源文件、临时文件）不要放皮肤目录。

## 新增/更换皮肤

1. 建 `src/views/pet/skins/pet/<id>/`：写 `index.ts` 实现 `PetModel` 契约
   （draw / hitTest / resolveAnchor / visualBounds / selfContainedOverlays）；
   矢量皮肤把绘制代码写在这里，序列帧皮肤放 `<clip>.gif` 源素材；
2. `SKIN.md` 写人工管理清单（类型/出处/许可）；
3. 注册两处：`src/views/pet/models/registry.ts` 的 `PET_MODELS` 数组 +
   `src/shared/pet-actions.ts` 的 `PET_MODEL_CHOICES`；
4. 序列帧皮肤：帧数表 `CLIP_FRAME_COUNTS` 必须与 GIF 实际帧数严格一致
   （decode 脚本会在构建期校验，不符直接失败）。

## 版权

本库中 GIF 素材为社区二创（出处见各皮肤 SKIN.md），**非商业许可**；
个人/内部使用，商用需联系原作者授权。上传公开仓库前请确认授权边界。
