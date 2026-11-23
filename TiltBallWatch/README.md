# BallClock (watchOS)

手首の傾きでボールが転がる時計アプリ。ボールは時刻の数字にぶつかって跳ね返ります。
Apple Watch の文字盤そのものは作れないため、watchOS アプリとして動きます。

## ビルド（Mac + Xcode 15 以降）

```sh
brew install xcodegen
cd TiltBallWatch
xcodegen            # TiltBallWatch.xcodeproj を生成
open TiltBallWatch.xcodeproj
```

1. Xcode で Signing の Team を自分の Apple ID に設定（`project.yml` の `com.example` も任意の ID に変更）。
2. Run 先に自分の Apple Watch（または Simulator）を選んで実行。
   Simulator は傾きセンサーが動かないので、ボールは動きません。実機で確認してください。

## 文字盤のように使う

- 時計の「設定 → 一般 → 画面を点灯させる → 最近使ったアプリに戻る」で、戻るまでの時間を延ばす。
- または、同じ画面の「アプリに戻る」でこのアプリを選び、最長 1 時間出しっぱなしにする。
- Apple Watch Ultra はアクションボタンにこのアプリを割り当てると 1 回で起動できる。
- 常時表示（画面が暗い状態）では、時刻だけが表示されてボールは止まります。
