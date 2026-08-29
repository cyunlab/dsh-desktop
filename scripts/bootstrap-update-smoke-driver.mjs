/** 拒绝在缺少安全原生 fresh-install 自动化时伪造 bootstrap 成功证据。 */
function main() {
  throw new Error('repository-owned native bootstrap fresh-install automation is not implemented; no evidence was emitted')
}

main()
