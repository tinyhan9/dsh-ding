/**
 * dsh-ding —— Node 半边。
 *
 * 这个插件全部行为都在浏览器半边（`exports["./client"]`）：监听每会话的
 * running 位，从 true 掉到 false 时播一声提示音。Node 半边只提供一个空 apply，
 * 让 Loader 有一行可挂载的 Host 实体，不注册任何服务、不写任何文件、不连任何网。
 *
 * 故意不依赖 schemastery / settings：偏好存在浏览器 localStorage，
 * 因此换 DSH 版本、换 profile 都不会因为 schema 漂移而挂掉。
 */

/** Host 插件体：仅占位，无副作用。 */
export function apply() {}
