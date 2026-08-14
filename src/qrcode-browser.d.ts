declare module "qrcode/lib/browser" {
  import type { QRCodeOptions, QRCodeToDataURLOptions } from "qrcode";

  const QRCode: {
    toDataURL(text: string, options?: QRCodeOptions & QRCodeToDataURLOptions): Promise<string>;
  };

  export default QRCode;
}
