export const PAYMENT_METHOD_OPTIONS = ["现金", "微信", "支付宝"] as const;

export function resolvePaymentMethodValue(value: string | null | undefined) {
  return value?.trim() || PAYMENT_METHOD_OPTIONS[0];
}
