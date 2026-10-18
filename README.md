# AUDScan (Proof of Concept)

AUDScan is a mobile app that checks Australian banknotes for signs of counterfeiting using the
phone camera. It reads the serial number to find the denomination, then measures how the
optically variable ink changes colour as the note is tilted. It photographs the note at three
tilt angles: a flat printed copy does not change colour with viewing angle; a genuine note does.

AUDScan is a senior project proof of concept (Team 26047). It is not a certified counterfeit detector.

## Members

| Name | Student ID |
|---|---|
| Jatupon Itsara | 6610073 |
| Gulizara Benjapalaporn | 6612233 |

## Download and use the test app

> [!IMPORTANT]
> **Download link:** https://drive.google.com/drive/folders/1iAsfgnskaW1bQ6zQH7S6OpZIE6adog9I?usp=sharing
>
> The folder contains the Android installer, `AUDScan-POC.apk`.
>
> **Before you start**
>
> - **Android only.** The installer works only on Android phones (see *Why Android only* below).
> - **Space:** the file is about 180 MB, so download it over Wi-Fi.
> - **Internet:** an internet connection is needed to start a scan, because the app downloads its note-recognition model when the scan screen opens. The photos never leave the phone.
> - **Camera:** the app asks for camera permission the first time you scan.
>
> **How to install**
>
> 1. **Open the download link on your Android phone** in the Google Drive app or in Chrome.
> 2. **Download the file.** Tap `AUDScan-POC.apk`, then tap **Download** (⋮ menu → Download). Because the file is large, Google Drive may say it can't scan it for viruses. Tap **Download anyway**.
> 3. **Open the downloaded file.** Tap the download notification, or open the **Files** app → **Downloads** → `AUDScan-POC.apk`.
> 4. **Allow installs from this source.** Android blocks apps from outside the Play Store by default, so it will ask you to allow the app you are installing from (for example Chrome, Drive or Files). Tap **Settings**, turn on **Allow from this source**, then go back.
> 5. **Install.** Tap **Install**. If Google Play Protect warns that the app is from an unknown developer, tap **More details** → **Install anyway**. This warning appears because the app is not published on the Play Store.
> 6. **Open AUDScan** and allow camera access when asked.
>
> The exact wording of the menus may vary slightly between phone brands and Android versions.
>
> **How to scan a note**
>
> 1. Open the scan screen and read the short how-to-scan guide.
> 2. Lay the note flat inside the on-screen frame in good, even light. The app reads the serial number and the value.
> 3. Tilt the phone to the left and then to the right when asked. The app takes three photos automatically when the tilt is reached.
> 4. Read the result:
>    - **GENUINE NOTE**: the colour-shifting ink was detected.
>    - **REVIEW NOTE**: the colour shift was not detected. Check the note by hand.
>    - **SCAN AGAIN**: the scan could not be completed (for example, the value was not read or the phone was not tilted far enough).
>
> **Why Android only**
>
> Android lets users install apps directly from an installer file (APK) after giving permission. iOS does not: an iPhone can only install apps from the App Store or from Apple's beta-testing service, TestFlight, by invitation. An iPhone cannot install an app downloaded from a shared folder like the one above.
>
> Both the App Store and TestFlight require the developer to join the Apple Developer Program, which costs US$99 per year. Installing through TestFlight is free for testers, but the developer must pay this fee to send the invitations. For this proof of concept, the app is shared free as an Android installer instead.
>
> **Limitations**
>
> - This is a proof of concept. A **REVIEW NOTE** result is not proof that a note is fake, and a **GENUINE NOTE** result is not a guarantee. Always confirm with a manual check.
> - Only one security feature is checked: the colour-shifting ink.
> - The app was tested with paper colour copies only, not real counterfeit notes. It worked best on the $5 and $50 notes.
> - An internet connection is needed to start a scan.
> - Notes from other countries are not rejected and should not be scanned.
