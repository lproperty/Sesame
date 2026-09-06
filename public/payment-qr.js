import qrcode from "./vendor/qrcode.mjs";

export function createPaymentQr(text) {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  return code.createSvgTag({
    cellSize: 6,
    margin: 24,
    scalable: true,
    title: "PayNow payment QR",
  });
}
