import { useRef } from 'react'
import type { KeyboardEvent, MouseEvent, ReactElement, ReactNode } from 'react'

interface ModalProps {
  children: ReactNode
  onClose: () => void
  wide?: boolean
  /** 追加到弹窗容器的类名（用于自定义尺寸/布局） */
  className?: string
}

/**
 * 通用弹窗外壳。
 *
 * 关闭策略：只接受明确的用户意图，避免弹窗被误关——
 *  1. 点击遮罩：必须 mousedown 与 click 都落在遮罩自身，
 *     这样从弹窗内部拖拽到遮罩上松手不会误关（拖拽文本时尤其明显）；
 *  2. 按下 Escape。
 *
 * 另外，弹窗内的按键事件不再向外冒泡，
 * 避免粘贴等快捷键穿透到应用层或原生菜单去触发别的动作。
 */
export default function Modal({ children, onClose, wide, className }: ModalProps): ReactElement {
  const pointerDownOnBackdrop = useRef(false)

  const handleBackdropMouseDown = (e: MouseEvent<HTMLDivElement>): void => {
    pointerDownOnBackdrop.current = e.target === e.currentTarget
  }

  const handleBackdropClick = (e: MouseEvent<HTMLDivElement>): void => {
    const shouldClose = e.target === e.currentTarget && pointerDownOnBackdrop.current
    pointerDownOnBackdrop.current = false
    if (shouldClose) onClose()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // 阻止快捷键继续向外传播
    e.stopPropagation()
    if (e.key === 'Escape') onClose()
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
    >
      <div
        className={className ? `modal ${className}` : wide ? 'modal wide' : 'modal'}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>
  )
}
