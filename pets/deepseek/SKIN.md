# DeepSeek 娘（deepseek）

- **类型**：序列帧皮肤
- **动作维护**：`index.ts`（本目录）声明帧数表/动作映射/各段 fps；视觉
  源素材是本目录的 6 个 `<clip>.gif`
- **源素材**：GIF 来自社区二创（出处 github.com/aceice01/dsh-whale-pet，
  非商业许可；个人/内部使用，商用需联系原作者授权）
- **构建产物**：`<clip>/f_NN.png` 由 `scripts/decode-pet-skins.ts` 从 GIF
  解帧直写 dist/views/pet/deepseek/，并按 `CLIP_FRAME_COUNTS` 校验帧数
  （**不进 git，也不进皮肤库**）；无 ffmpeg 的环境跳过生成（皮肤空白但
  不失败），打包发布前需在有 ffmpeg 的环境构建
- **运行时**：模型代码用相对路径 `deepseek/<clip>/f_NN.png` 加载；帧数表
  与各段 fps 为人工调校值，非 GIF 原生帧率
