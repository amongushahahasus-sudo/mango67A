# 個人アカウントの接続設定

Googleログイン・メールアドレス＋パスワードと、利用者本人だけが読めるクラウド口座を準備します。アプリ側のコードを置くだけでは、実際の認証サービスは有効になりません。以下は所有者がSupabase / Googleの画面で行う設定です。


## 今回接続するプロジェクト

所有者からGmailのCustom SMTP設定完了の申告を受け、メール新規登録・再設定を有効にする設定に更新しました。実配送は、公開アプリから所有者が登録・再設定を試して確認します。公開APIではSMTPの認証情報を検証していません。

- [Supabaseの管理画面](https://supabase.com/dashboard/project/wqczekzebhukjayyhuln/explorer)
- 接続先: `https://wqczekzebhukjayyhuln.supabase.co`
- Google OAuthの戻り先: `https://wqczekzebhukjayyhuln.supabase.co/auth/v1/callback`

接続先URLと公開用キーはアプリに設定済みです。口座テーブルと保存用関数の作成、匿名での読み書きの拒否を確認しました。Google Providerの有効化と、Googleの認可画面へ正しいSupabaseコールバックを指定して移動するところまで確認済みです。所有者が公開アプリでGoogleログインを完了し、自分の口座を保存・再読込する確認はまだ必要です。

`ACCOUNT_CONFIG.emailRegistrationReady` は現在 `true` です。メールの実到着と確認リンク・再設定リンクからのログインは、所有者の操作で確認します。

## 1. Supabaseプロジェクトを作る

[Supabase管理画面](https://supabase.com/dashboard)で「New project」を選択します。組織・プロジェクト名（例 `mango-fx`）・データベースパスワード・リージョンを設定し、作成が完了するまで待ちます。パスワードはSupabaseの画面で設定・保管し、チャットやソースコードには記載しません。

「Project Settings → API」または接続情報の画面から、次の**公開用設定**を確認します。画面名はSupabaseのバージョンによって異なります。

- Project URL（`https://<project-ref>.supabase.co`）
- Publishable key（`sb_publishable_...`）、または旧形式の `anon public` key

`Secret key`、`service_role`、データベース接続パスワードはアプリに設定しません。公開キーはブラウザに配信される値です。権限の保護は次のSQLのRLSで行います。

開発時は `.env.local` に `VITE_SUPABASE_URL` と `VITE_SUPABASE_PUBLISHABLE_KEY` を設定できます。公開サイト向けには、管理者が確認した公開設定を `src/config/accountConfig.ts` の `ACCOUNT_CONFIG` に記載する方法にも対応します。

## 2. 利用者ごとの保存先を作る

Supabaseの「SQL Editor」で新しいクエリを開き、[schema.sql](./schema.sql)全体を貼り付けて実行します。成功したことを確認してください。

作成されるのは `practice_accounts` テーブルと保存用RPCです。匿名利用者はアクセスできず、ログインした本人だけが自分の行を読み取れます。書き込みは認証済み本人と期待する更新番号を確認するRPCだけに許可します。同じプロジェクトで再実行しても既存の口座行は削除しません。再実行ではアプリ用の形式チェックも更新・検証します。古い不正なデータがある場合は処理全体がロールバックされるため、エラーを確認してから対応し、口座行をむやみに削除しないでください。

## 3. メールアドレスでの登録を設定する

「Authentication → Sign In / Providers」でEmailを有効にし、**メール確認を有効**にします。Site URLは次のURLに設定します。

```text
https://amongushahahasus-sudo.github.io/mango67A/
```

「Authentication → URL Configuration」のRedirect URLsにも同じURLを追加します。開発用に必要な場合だけ `http://localhost:5173/` と `http://127.0.0.1:5173/` を追加してください。不要なワイルドカードは使用しません。

確認メール・パスワード再設定メールの送信はSupabaseの送信サービス設定に依存します。標準メールサービスには宛先制限やレート制限があるため、一般の利用者へ提供する前に、自分の管理するSMTPサービスを設定して実メールで配送を検証してください。登録APIの成功だけではメール到着を確認できません。

### GmailでCustom SMTPを設定する例

自分で管理している個人用Gmailを送信元に使う例です。Googleログイン用のOAuth設定とは別に、Supabaseが確認メールを送るための設定を行います。

1. 送信元にするGoogleアカウントで、[2段階認証](https://myaccount.google.com/signinoptions/two-step-verification)を有効にします。
2. 同じアカウントの[アプリパスワード画面](https://myaccount.google.com/apppasswords)を開き、名前を `MANGO FX SMTP` などにして作成します。表示された16文字のアプリパスワードは、次のSupabase画面にだけ入力します。普段のGoogleログイン用パスワードは使いません。
3. [このプロジェクトのSMTP設定](https://supabase.com/dashboard/project/wqczekzebhukjayyhuln/auth/smtp)を開き、Custom SMTPを有効にします。メニューから開く場合はAuthentication内のEmail / SMTP設定を探してください。画面名は変更される場合があります。
4. 次の値を入力して保存します。

| Supabaseの項目 | 入力する値 |
| --- | --- |
| SMTP Host | `smtp.gmail.com` |
| Port | `465`（SSL/TLS） |
| Username | 送信元のGmailアドレス全体 |
| Password | 手順2で作成した16文字のアプリパスワード |
| Sender email | Usernameと同じGmailアドレス |
| Sender name | `MANGO FX` |

アプリパスワードをチャット、GitHub、アプリの接続設定へ記載する必要はありません。SupabaseのSMTP Password欄だけで扱ってください。メール確認を無効にして送信エラーを回避する必要もありません。

5. 保存できたら、パスワードを添えずに「SMTP設定完了」と知らせてください。送信設定を確認した後、アプリのメール新規登録・再設定を有効化します。
6. 有効化後、ご自身で公開アプリからメール登録を行い、確認メールの到着とリンクからのログインを確認します。続いてパスワード再設定メールと、変更後のログインも試してください。ここまで完了して初めて実配送・実ログインを確認済みとします。

アプリパスワードの項目が出ない場合、職場・学校の管理アカウントやGoogle側の保護設定などで利用できないことがあります。その場合はGoogleの通常パスワードを代用せず、SMTPに対応するメール配信サービス（Resend、Brevoなど）を利用してください。サービスの画面で発行されたHost・Port・Username・Passwordと、承認された送信元アドレスをSupabaseに設定します。個人Gmailにも送信数制限があるため、利用人数が増える場合はメール配信サービスへの移行を検討できます。

公式資料: [Googleのアプリパスワード](https://support.google.com/accounts/answer/185833?hl=ja) / [GmailのSMTP仕様](https://developers.google.com/workspace/gmail/imap/imap-smtp) / [SupabaseのCustom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)


## 4. Googleログインを設定する

1. [Google Cloud Console](https://console.cloud.google.com/)でプロジェクトを選択・作成し、Google Auth Platformの同意画面を設定します。
2. 対象ユーザーを設定し、OAuthクライアントを「ウェブアプリケーション」として作成します。テスト中は対象アカウントをテストユーザーへ登録してください。一般公開にはGoogle側での公開設定が必要です。
3. 許可するJavaScript生成元にアプリのorigin `https://amongushahahasus-sudo.github.io` を設定します。生成元には `/mango67A/` のようなパスを含めません。
4. 承認済みリダイレクトURIに、SupabaseのGoogle Provider画面に表示されるコールバックURLを**そのまま**追加します。通常は以下の形式です。

   ```text
   https://<project-ref>.supabase.co/auth/v1/callback
   ```

5. Googleが発行するClient ID / Client Secretは、**SupabaseのGoogle Provider設定画面だけ**に入力し、Google Providerを有効にします。Client Secretをアプリ、GitHub、チャットへ記載する必要はありません。
6. SupabaseのRedirect URLsにアプリの公開URLが含まれていることを再確認します。

GoogleからはまずSupabaseのコールバックへ戻り、その後アプリへ戻ります。両者のURLを取り違えないでください。PKCEのため、最初に認証を開始したブラウザで戻り先を開きます。

## 5. 実サービスで確認する

自動テストとローカル検証だけでは実際のGoogleログインやメール配送を検証できません。接続後は次を確認します。

- 異なるGoogleアカウントA・Bでそれぞれログインし、各自の口座・履歴が分離される。
- 別のブラウザ／端末で同じアカウントAにログインするとAの練習を読み込める。
- メール登録→メール確認→ログイン、パスワード再設定が実際のメールで完了する。
- アカウントを切り替えると、前の利用者の建玉・履歴が次の利用者に表示・保存されない。
- 二つの端末で同じ口座を編集したとき、古い状態で黙って上書きせず競合の選択が表示される。

### RLSを確かめる追加チェック

実際に用意したA・Bの認証セッションを使い、SupabaseクライアントまたはAPIテストから次を検証してください。アクセストークンはテスト端末の中で扱い、チャットやログに出しません。

1. Aで自分の口座を保存した後、Bのセッションで `practice_accounts` のAの `user_id` を指定して読んでも行が返らない。
2. Bから保存RPCへAの `p_expected_user_id` を送ると `ACCOUNT_USER_CHANGED` で拒否され、Aの行が変わらない。
3. 認証なしの公開キーだけではテーブルや保存RPCを利用できない。
4. 同じ更新番号で二度保存すると、二回目は `ACCOUNT_CONFLICT` となり、一回目の内容が残る。

RLSを無効化したり、サービス用キーをフロントエンドへ置いて回避してはいけません。
