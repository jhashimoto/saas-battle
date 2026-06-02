# LINE Mini App SaaS Battle

LINEミニアプリ黎明期のSaaSパートナーとして市場を制する経営シミュレーションゲーム。

## セットアップ

```bash
npm install
npm run dev
```

ブラウザで http://localhost:3000 を開く。

## ビルド（本番用）

```bash
npm run build
npm run preview
```

`dist/` フォルダが生成される。Vercel / Netlify にドロップするだけでデプロイ可能。

## 多人数対応（次のステップ）

Firebase Realtime Database を追加することでオンライン対戦が可能になる。
詳細は別途実装予定。

## 技術スタック

- React 18
- Vite 5
- Firebase（予定）
