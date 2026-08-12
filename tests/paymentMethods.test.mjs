import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadPaymentMethods() {
  const source = await readFile(new URL("../src/lib/paymentMethods.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("entry payment methods are limited to cash, WeChat, and Alipay", async () => {
  const { PAYMENT_METHOD_OPTIONS, resolvePaymentMethodValue } = await loadPaymentMethods();

  assert.deepEqual(PAYMENT_METHOD_OPTIONS, ["现金", "微信", "支付宝"]);
  assert.equal(resolvePaymentMethodValue(), "现金");
  assert.equal(resolvePaymentMethodValue("银行卡"), "银行卡");
  assert.equal(resolvePaymentMethodValue("其他"), "其他");
});
