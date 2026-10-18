import React, { forwardRef, useImperativeHandle, useRef } from "react";
import { StyleProp, ViewStyle } from "react-native";
import { Camera, useCameraDevice } from "react-native-vision-camera";
import * as ImageManipulator from "expo-image-manipulator";

// Drop-in replacement for expo-camera's <CameraView> as used by CameraScreen.
// expo-camera has no native exposure control, and the colour-shifting ink
// washes out under auto-exposure, so this wraps react-native-vision-camera
// (which does) and exposes the same takePictureAsync / onCameraReady API.

// Width photos are resized to before analysis. Full sensor JPEGs made
// base64 decoding on the JS thread take many seconds.
const MAX_WIDTH = 1600;

export interface ExposureCameraHandle {
  takePictureAsync: (opts?: { base64?: boolean; quality?: number }) => Promise<{
    uri: string; base64?: string; width: number; height: number;
  }>;
  getAvailablePictureSizesAsync: () => Promise<string[]>;
}

interface Props {
  style?: StyleProp<ViewStyle>;
  enableTorch?: boolean;
  // Exposure bias in EV stops (negative = darker). Clamped to what the
  // device supports. Leave undefined for normal auto-exposure.
  exposure?: number;
  onCameraReady?: () => void;
  // Accepted for call-site compatibility with CameraView; unused here.
  facing?: "back";
  pictureSize?: string;
}

export const ExposureCamera = forwardRef<ExposureCameraHandle, Props>(
  ({ style, enableTorch, exposure, onCameraReady }, ref) => {
    const device = useCameraDevice("back");
    const camRef = useRef<Camera>(null);

    useImperativeHandle(ref, () => ({
      async takePictureAsync(opts) {
        if (!camRef.current) throw new Error("camera not ready");
        const shot = await camRef.current.takePhoto({ enableShutterSound: false });
        const uri = shot.path.startsWith("file://") ? shot.path : `file://${shot.path}`;
        if (!opts?.base64) {
          return { uri, width: shot.width, height: shot.height };
        }
        const scale = shot.width > MAX_WIDTH ? MAX_WIDTH / shot.width : 1;
        const out = await ImageManipulator.manipulateAsync(
          uri,
          scale < 1 ? [{ resize: { width: Math.round(shot.width * scale) } }] : [],
          {
            compress: opts?.quality ?? 0.8,
            format: ImageManipulator.SaveFormat.JPEG,
            base64: true,
          },
        );
        return { uri: out.uri, base64: out.base64, width: out.width, height: out.height };
      },
      async getAvailablePictureSizesAsync() { return []; },
    }));

    if (!device) return null;

    const ev = exposure === undefined
      ? undefined
      : Math.max(device.minExposure, Math.min(device.maxExposure, exposure));

    if (exposure !== undefined) {
      console.log(`[Camera] exposure requested=${exposure} deviceRange=[${device.minExposure}, ${device.maxExposure}] -> applying=${ev}`);
    }

    return (
      <Camera
        ref={camRef}
        style={style}
        device={device}
        isActive
        photo
        torch={enableTorch && device.hasTorch ? "on" : "off"}
        exposure={ev}
        onInitialized={onCameraReady}
      />
    );
  },
);
