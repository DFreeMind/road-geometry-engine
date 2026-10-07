import { afterEach, describe, expect, it, vi } from "vitest";
import type { Map } from "maplibre-gl";
import {
  installMapWheelHandling,
  installPageZoomGuard,
  wheelIntent,
} from "../src/workbench/MapInteraction";

describe("网页默认缩放隔离", () => {
  function setup() {
    const listeners: Record<string, (event: any) => void> = {};
    const target = {
      addEventListener: vi.fn((name, handle) => {
        listeners[name] = handle;
      }),
      removeEventListener: vi.fn(),
    };
    const cleanup = installPageZoomGuard(target as unknown as Window);
    return { target, listeners, cleanup };
  }
  it("阻止 Ctrl 捏合默认网页缩放但仍向地图传播", () => {
    const t = setup();
    const event = {
      ctrlKey: true,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    t.listeners.wheel(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    const normal = { ctrlKey: false, preventDefault: vi.fn() };
    t.listeners.wheel(normal);
    expect(normal.preventDefault).not.toHaveBeenCalled();
    t.cleanup();
    expect(t.target.removeEventListener).toHaveBeenCalledTimes(2);
  });
  it("缩放快捷键只阻止网页默认行为，不影响其他快捷键", () => {
    const t = setup();
    for (const key of ["+", "=", "-", "0"]) {
      const event = { ctrlKey: true, key, preventDefault: vi.fn() };
      t.listeners.keydown(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    for (const options of [
      { ctrlKey: true, key: "s" },
      { ctrlKey: false, key: "+" },
      { ctrlKey: true, altKey: true, key: "-" },
    ]) {
      const event = { ...options, preventDefault: vi.fn() };
      t.listeners.keydown(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    t.cleanup();
  });
});

describe("地图设备滚动意图", () => {
  it("捏合优先于滚动幅度和方向", () => {
    expect(
      wheelIntent({ ctrlKey: true, deltaMode: 0, deltaX: 0, deltaY: 120 }),
    ).toBe("pinch");
  });
  it("任意幅度的垂直滚动都缩放，纯水平滚动用于平移", () => {
    for (const deltaY of [2.5, -12, 86.5, 120]) {
      expect(
        wheelIntent({ ctrlKey: false, deltaMode: 0, deltaX: 0, deltaY }),
      ).toBe("zoom");
    }
    expect(
      wheelIntent({ ctrlKey: false, deltaMode: 0, deltaX: 18, deltaY: 0 }),
    ).toBe("pan");
    expect(
      wheelIntent({ ctrlKey: false, deltaMode: 0, deltaX: 18, deltaY: 0.25 }),
    ).toBe("zoom");
  });
  it("行单位及页面单位垂直滚动也缩放", () => {
    for (const [deltaMode, deltaY] of [
      [0, 120],
      [0, -100],
      [1, 3],
      [2, 1],
    ]) {
      expect(
        wheelIntent({ ctrlKey: false, deltaMode, deltaX: 0, deltaY }),
      ).toBe("zoom");
    }
  });
});

describe("地图触控板事件调度", () => {
  afterEach(() => vi.unstubAllGlobals());
  function setup() {
    const frames = new globalThis.Map<number, FrameRequestCallback>();
    let sequence = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++sequence, callback);
      return sequence;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    let listener: (event: WheelEvent) => void;
    let dragging = false;
    let zoom = 10;
    const canvas = {
      clientHeight: 400,
      getBoundingClientRect: () => ({ left: 10, top: 20 }),
    };
    const container = {
      addEventListener: vi.fn((_name, handle) => {
        listener = handle;
      }),
      removeEventListener: vi.fn(),
    };
    const map = {
      getCanvas: () => canvas,
      getContainer: () => container,
      panBy: vi.fn(),
      getZoom: () => zoom,
      getMinZoom: () => 0,
      getMaxZoom: () => 22,
      unproject: vi.fn((point) => point),
      zoomTo: vi.fn((next: number) => {
        zoom = next;
      }),
    };
    const cleanup = installMapWheelHandling(
      map as unknown as Map,
      () => dragging,
    );
    const send = (options: Record<string, unknown> = {}) => {
      const event = {
        target: canvas,
        ctrlKey: false,
        deltaMode: 0,
        deltaX: 0,
        deltaY: 2,
        clientX: 50,
        clientY: 60,
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
        ...options,
      };
      listener(event as unknown as WheelEvent);
      return event;
    };
    const render = () => {
      for (const callback of [...frames.values()]) callback(0);
    };
    return {
      map,
      frames,
      container,
      cleanup,
      send,
      render,
      setDragging: () => {
        dragging = true;
      },
      setZoom: (value: number) => {
        zoom = value;
      },
    };
  }
  it("一帧合并纯水平滚动平移而不是逐事件重绘", () => {
    const t = setup();
    t.send({ deltaX: 3, deltaY: 0 });
    t.send({ deltaX: 4, deltaY: 0 });
    expect(t.map.panBy).not.toHaveBeenCalled();
    expect(t.frames.size).toBe(1);
    t.render();
    expect(t.map.panBy).toHaveBeenCalledExactlyOnceWith([7, 0], {
      duration: 0,
    });
    t.cleanup();
  });
  it("精细垂直滚动缩放并以指针位置为锚点", () => {
    const t = setup();
    t.send({ deltaY: 2.5 });
    t.send({ deltaY: 2.5 });
    expect(t.map.zoomTo).not.toHaveBeenCalled();
    t.render();
    expect(t.map.zoomTo).toHaveBeenLastCalledWith(9.95, {
      around: [40, 40],
      duration: 0,
    });
    expect(t.map.panBy).not.toHaveBeenCalled();
    t.cleanup();
  });
  it("捏合双向缩放、指针锚点和最大级别有界", () => {
    const t = setup();
    t.send({ ctrlKey: true, deltaY: -10 });
    t.send({ ctrlKey: true, deltaY: -15 });
    t.render();
    expect(t.map.zoomTo).toHaveBeenLastCalledWith(10.25, {
      around: [40, 40],
      duration: 0,
    });
    t.send({ ctrlKey: true, deltaY: 25 });
    t.render();
    expect(t.map.zoomTo).toHaveBeenLastCalledWith(10, {
      around: [40, 40],
      duration: 0,
    });
    t.setZoom(21.9);
    t.send({ ctrlKey: true, deltaY: -500 });
    t.render();
    expect(t.map.zoomTo).toHaveBeenLastCalledWith(22, {
      around: [40, 40],
      duration: 0,
    });
    t.cleanup();
  });
  it("离散滚轮接管缩放，浮层滚动保持原样", () => {
    const t = setup();
    expect(t.send({ deltaY: 120 }).preventDefault).toHaveBeenCalledOnce();
    t.render();
    expect(t.map.zoomTo).toHaveBeenLastCalledWith(9, {
      around: [40, 40],
      duration: 0,
    });
    expect(t.send({ target: {} }).preventDefault).not.toHaveBeenCalled();
    t.cleanup();
  });
  it("拖点期间抑制垂直缩放和捏合，卸载取消动画帧", () => {
    const t = setup();
    t.send();
    t.setDragging();
    t.render();
    expect(t.map.panBy).not.toHaveBeenCalled();
    expect(t.map.zoomTo).not.toHaveBeenCalled();
    expect(t.send().preventDefault).toHaveBeenCalledOnce();
    expect(t.send({ ctrlKey: true }).preventDefault).toHaveBeenCalledOnce();
    expect(t.frames.size).toBe(0);
    t.cleanup();
    expect(t.frames.size).toBe(0);
    expect(t.container.removeEventListener).toHaveBeenCalledOnce();
  });
  it("卸载前未执行的手势不会改变地图", () => {
    const t = setup();
    t.send({ ctrlKey: true, deltaY: -10 });
    t.cleanup();
    t.render();
    expect(t.map.zoomTo).not.toHaveBeenCalled();
    expect(t.frames.size).toBe(0);
  });
});
