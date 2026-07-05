# LINE Mini App SaaS Battle

LINEミニアプリ黎明期のSaaSパートナーとして市場を制する経営シミュレーションゲーム。

## セットアップ

```bash
npm install
npm run dev
```

ブラウザで http://localhost:3000 を開く（`.env.development`の開発用LIFF IDが使われる）。

## LINEミニアプリ（LIFF）設定

チャネルごとにLIFF IDを`.env.development` / `.env.review` / `.env.production`に分けて管理している。
Viteの`--mode`でどのファイルを読むかが決まる。

| 用途 | チャネル | 環境ファイル | ビルドコマンド |
|---|---|---|---|
| ローカル開発 | 開発用 (2010610047) | `.env.development` | `npm run dev` |
| ミニアプリ審査提出 | 審査用 (2010610048) | `.env.review` | `npm run build:review` |
| 本番リリース | 本番用 (2010610049) | `.env.production` | `npm run build` |

**チャネルシークレットはこのリポジトリのどこにも含めない。** LIFF IDはクライアントに公開されて問題ないが、
チャネルシークレットはサーバーサイド専用（Webhook署名検証・IDトークン検証など）であり、現状このアプリには
サーバーサイド処理が存在しないため使用していない。将来サーバー処理を追加する場合は、Vercelの
サーバー用環境変数（`VITE_`接頭辞を付けない）としてのみ設定すること。

Vercelにデプロイする場合、本番プロジェクトのビルドコマンドは`npm run build`のままでよい。審査用ビルドを
別途配布したい場合は、審査用ブランチ／別プロジェクトのビルドコマンドを`npm run build:review`に変更する。

## ビルド（本番用）

```bash
npm run build
npm run preview
```

`dist/` フォルダが生成される。Vercel / Netlify にドロップするだけでデプロイ可能。

## 多人数対応

Firebase Realtime Database でオンライン対戦に対応済み（`src/useRoom.js`）。

## 技術スタック

- React 18
- Vite 5
- Firebase Realtime Database
- LINE LIFF (`@line/liff`)
