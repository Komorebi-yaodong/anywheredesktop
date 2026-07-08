export async function runTaskById({ taskId = '', dataApi, openWindow } = {}) {
  const normalizedTaskId = typeof taskId === 'string' ? taskId.trim() : ''
  if (!normalizedTaskId) {
    return {
      success: false,
      reason: 'task_id_required'
    }
  }

  if (!dataApi || typeof dataApi.getConfig !== 'function') {
    return {
      success: false,
      reason: 'data_api_missing',
      taskId: normalizedTaskId
    }
  }

  if (typeof openWindow !== 'function') {
    return {
      success: false,
      reason: 'open_window_missing',
      taskId: normalizedTaskId
    }
  }

  const configResult = await dataApi.getConfig()
  const fullConfig =
    configResult?.config && typeof configResult.config === 'object' ? configResult.config : {}
  const tasks = fullConfig?.tasks && typeof fullConfig.tasks === 'object' ? fullConfig.tasks : {}
  const task = tasks[normalizedTaskId]

  if (!task || typeof task !== 'object') {
    return {
      success: false,
      reason: 'task_not_found',
      taskId: normalizedTaskId
    }
  }

  const promptKey = typeof task.promptKey === 'string' && task.promptKey ? task.promptKey : '__DEFAULT__'
  const modelRoute = ['superior', 'general', 'fast'].includes(task?.modelRoute) ? task.modelRoute : 'general'
  const tempPromptConfig =
    promptKey === '__DEFAULT__'
      ? {
          type: 'general',
          prompt: '',
          showMode: 'window',
          model:
            typeof dataApi.resolveDefaultAssistantModel === 'function'
              ? dataApi.resolveDefaultAssistantModel(fullConfig, modelRoute)
              : '',
          stream: true,
          isAlwaysOnTop: fullConfig.isAlwaysOnTop_global ?? true,
          autoCloseOnBlur: fullConfig.autoCloseOnBlur_global ?? true,
          window_width: 580,
          window_height: 740,
          icon: ''
        }
      : null

  const openPayload = {
    code: promptKey,
    type: 'task',
    payload: typeof task.description === 'string' ? task.description : '',
    taskConfig: {
      id: normalizedTaskId,
      ...task
    },
    tempPromptConfig
  }

  const openResult = await openWindow('window', openPayload)

  return {
    success: Boolean(openResult?.ok),
    taskId: normalizedTaskId,
    target: openResult?.id || null,
    event: 'window:open',
    result: openResult
  }
}
