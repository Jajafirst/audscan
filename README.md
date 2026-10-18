# AUDScan

AUDScan is a mobile app that checks Australian banknotes for signs of counterfeiting using the
phone camera. It reads the serial number to find the denomination, then measures how the
optically variable ink changes colour as the note is tilted. A flat printed copy does not change
colour with viewing angle; a genuine note does.

## Members

| Name | Student ID |
|---|---|
| Jatupon Itsara | 6610073 |
| Gulizara Benjapalaporn | 6612233 |

## Download the app

https://drive.google.com/drive/folders/1iAsfgnskaW1bQ6zQH7S6OpZIE6adog9I?usp=sharing

## Build from source

The app uses the real camera, torch and tilt sensor, so it does **not** run in Expo Go or a
simulator. Build it onto a real phone connected by USB.

### Requirements

- Node.js 20 or newer
- **iPhone:** a Mac with Xcode, CocoaPods (`brew install cocoapods`) and an Apple ID signed in to
  Xcode (Settings → Accounts)
- **Android:** Java JDK 17 and the Android SDK (Android Studio includes both). `adb` must be on
  your `PATH`.

### Install

```bash
git clone https://github.com/Jajafirst/audscan.git
cd audscan
npm install --legacy-peer-deps
```

`--legacy-peer-deps` is required. The install also applies the camera patch in `patches/`.

### iPhone

1. Plug in the phone, unlock it and tap **Trust**. Turn on Settings → Privacy & Security →
   **Developer Mode**.
2. Change `ios.bundleIdentifier` in `app.json` to your own (for example `com.yourname.audscan`).
3. Run `npx expo run:ios --device` and pick the phone. Do not run `pod install` separately.
4. If signing fails, open `ios/audscanmobile.xcworkspace` in Xcode → target **audscanmobile** →
   Signing & Capabilities → choose your Team.
5. On first launch: Settings → General → VPN & Device Management → trust your developer
   certificate.

### Android

1. Turn on Developer options (tap **Build number** 7 times), then **USB debugging** and
   **Install via USB**.
2. Plug in the phone and allow USB debugging. `adb devices` must show it as `device`.
3. Run `npx expo run:android --device`.

### After the first build

If only JavaScript changed, there is no need to rebuild:

```bash
npx expo start --dev-client
adb reverse tcp:8081 tcp:8081   # Android over USB
```

Allow the camera and motion permissions when the app asks.
