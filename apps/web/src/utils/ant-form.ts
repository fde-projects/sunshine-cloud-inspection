/** antd `validateFields` 失败时 reject 普通对象，不是 Error，Next 会显示成 [object Object] */
export function isAntValidateError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "errorFields" in error &&
      Array.isArray((error as { errorFields: unknown }).errorFields),
  );
}
