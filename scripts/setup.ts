import {existsSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';

const path=resolve('.env');
if(existsSync(path)) {
  console.log('已存在 .env，保留全部现有配置。运行 npm run doctor 查看缺项。');
  if((statSync(path).mode&0o077)!==0) console.log('建议将 .env 文件权限设为仅本人可读写 (chmod 600 .env)。');
} else {
  const template=readFileSync(new URL('../.env.example',import.meta.url),'utf8');
  writeFileSync(path,template.replace(/^INGEST_TOKEN=$/m,`INGEST_TOKEN=${randomBytes(32).toString('hex')}`)
    .replace(/^DASHBOARD_ACCESS_TOKEN=$/m,`DASHBOARD_ACCESS_TOKEN=${randomBytes(32).toString('hex')}`),{flag:'wx',mode:0o600});
  console.log('已创建本地 .env 并生成接收令牌（不输出密钥）。FxEmbed 免 Key 数据源已选定。');
  console.log('下一步：配置所需链的 RPC，运行 npm run doctor。默认使用供应商叙事，不需要模型 Key。');
}
