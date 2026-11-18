// src/ble-dice.ts

interface BleRemoteGATTCharacteristic extends EventTarget {
  value?: DataView;
  startNotifications(): Promise<BleRemoteGATTCharacteristic>;
}
interface BleRemoteGATTService {
  getCharacteristic(uuid: string): Promise<BleRemoteGATTCharacteristic>;
}
interface BleRemoteGATTServer {
  connected: boolean;
  connect(): Promise<BleRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BleRemoteGATTService>;
}
interface BleDevice extends EventTarget {
  name?: string;
  gatt?: BleRemoteGATTServer;
}

const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const CHARACTERISTIC_UUID_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

export interface BleDiceCallbacks {
  onShake: () => void;
  onStatusChange: (connected: boolean, deviceName?: string) => void;
  onError: (message: string) => void;
}

export class BleDiceController {
  private device: BleDevice | null = null;
  private characteristic: BleRemoteGATTCharacteristic | null = null;
  private connected = false;
  private lastShakeAt = 0;
  private decoder = new TextDecoder("utf-8");
  private callbacks: BleDiceCallbacks;

  constructor(callbacks: BleDiceCallbacks) {
    this.callbacks = callbacks;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "bluetooth" in navigator;
  }

  async connect(): Promise<void> {
    if (!BleDiceController.isSupported()) {
      this.callbacks.onError(
        "此瀏覽器不支援 Web Bluetooth（電腦請用 Chrome/Edge；iPhone 請用 Bluefy 瀏覽器）。"
      );
      return;
    }

    try {
      const nav = navigator as unknown as {
        bluetooth: {
          requestDevice(options: { filters: { services: string[] }[] }): Promise<BleDevice>;
        };
      };

      const device = await nav.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
      });

      this.device = device;
      device.addEventListener("gattserverdisconnected", this.handleDisconnect);

      const server = await device.gatt?.connect();
      if (!server) throw new Error("無法建立 GATT 連線");

      const service = await server.getPrimaryService(SERVICE_UUID);
      const char = await service.getCharacteristic(CHARACTERISTIC_UUID_TX);

      await char.startNotifications();
      char.addEventListener(
        "characteristicvaluechanged",
        this.handleCharacteristicValueChanged
      );

      this.characteristic = char;
      this.connected = true;
      this.lastShakeAt = performance.now();
      this.callbacks.onStatusChange(true, device.name || "M5-Dice");
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotFoundError") {
        return;
      }
      this.callbacks.onError(
        `M5Stack 藍牙連線失敗：${err instanceof Error ? err.message : String(err)}`
      );
      this.cleanup();
    }
  }

  disconnect(): void {
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.cleanup();
    this.callbacks.onStatusChange(false);
  }

  private handleCharacteristicValueChanged = (event: Event) => {
    if (!this.connected) return;
    const target = event.target as BleRemoteGATTCharacteristic;
    if (!target.value) return;

    const text = this.decoder.decode(target.value).trim();
    try {
      const data = JSON.parse(text);
      if (data?.event === "SHAKE") {
        const now = performance.now();
        if (now - this.lastShakeAt < 800) return;
        this.lastShakeAt = now;

        this.callbacks.onShake();
      }
    } catch {
      // 忽略非 JSON 或不完整封包
    }
  };

  private handleDisconnect = () => {
    this.cleanup();
    this.callbacks.onStatusChange(false);
  };

  private cleanup(): void {
    if (this.characteristic) {
      this.characteristic.removeEventListener(
        "characteristicvaluechanged",
        this.handleCharacteristicValueChanged
      );
      this.characteristic = null;
    }
    if (this.device) {
      this.device.removeEventListener(
        "gattserverdisconnected",
        this.handleDisconnect
      );
    }
    this.connected = false;
  }
}
