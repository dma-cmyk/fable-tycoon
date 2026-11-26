import { describe, expect, it } from 'vitest';
import {
  Camera,
  captureCamera,
  minZoomFor,
  PLAY_MIN_ZOOM_FACTOR,
  restoreCamera,
} from './camera';

describe('captureCamera / restoreCamera', () => {
  it('restores the exact centre and zoom after panning and zooming', () => {
    const cam = new Camera(8192, 4000, true);
    cam.setViewport(1920, 1080);
    cam.zoom = 1.4;
    cam.x = 1234.5;
    cam.y = 987.25;
    const snapshot = captureCamera(cam);

    cam.panByScreen(220, -90);
    cam.zoomAround(300, 300, 2.6);
    expect(cam.x).not.toBe(1234.5);

    restoreCamera(cam, snapshot);
    expect(cam.x).toBe(1234.5);
    expect(cam.y).toBe(987.25);
    expect(cam.zoom).toBe(1.4);
  });

  it('does not drop below the raised play floor when restoring the minimum view', () => {
    const cam = new Camera(8192, 4000, true);
    cam.setViewport(390, 844);
    cam.minZoomFactor = PLAY_MIN_ZOOM_FACTOR;
    const base = minZoomFor(390, 844, 8192, 4000);
    restoreCamera(cam, { x: 4096, y: 2000, zoom: base });
    expect(cam.zoom).toBeCloseTo(base * PLAY_MIN_ZOOM_FACTOR, 10);
  });

  it('cancels an in-flight tween so the restored camera stays put', () => {
    const cam = new Camera(8192, 4000, true);
    cam.setViewport(1280, 720);
    cam.zoom = 1;
    cam.x = 4000;
    cam.y = 2000;
    const snapshot = captureCamera(cam);
    void cam.startTween(5000, 2100, 2, 4000);
    expect(cam.isTweening()).toBe(true);
    restoreCamera(cam, snapshot);
    expect(cam.isTweening()).toBe(false);
    expect(cam.x).toBe(4000);
    expect(cam.zoom).toBe(1);
  });
});