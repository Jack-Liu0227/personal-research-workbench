import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { LoaderCircle, X } from 'lucide-react'
import {
  cloneElement,
  forwardRef,
  isValidElement,
  type ButtonHTMLAttributes,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes
} from 'react'
import { cn } from '../lib/utils'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'icon'
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'secondary', size = 'md', loading, children, disabled, title, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border text-sm font-semibold outline-none transition-colors duration-150',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45',
        variant === 'primary' && 'border-primary bg-primary text-primary-foreground hover:bg-primary-strong',
        variant === 'secondary' && 'border-border bg-surface text-foreground hover:bg-muted',
        variant === 'ghost' && 'border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
        variant === 'danger' && 'border-danger/30 bg-danger-subtle text-danger hover:bg-danger-subtle/75',
        size === 'sm' && 'h-8 px-3 text-xs',
        size === 'md' && 'h-9 px-3.5',
        size === 'icon' && 'size-8 p-0',
        className
      )}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      title={title ?? (typeof props['aria-label'] === 'string' ? props['aria-label'] : typeof children === 'string' ? children : undefined)}
      {...props}
    >
      {loading ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : null}
      {children}
    </button>
  )
)
Button.displayName = 'Button'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-md border border-input bg-surface px-3 text-sm text-foreground outline-none transition-colors duration-150',
        'placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
)
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'min-h-24 w-full resize-y rounded-md border border-input bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors duration-150',
        'placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
)
Textarea.displayName = 'Textarea'

export function Field({ label, htmlFor, error, hint, children }: {
  label: string
  htmlFor: string
  error?: string | undefined
  hint?: string | undefined
  children: ReactNode
}): React.JSX.Element {
  const descriptionId = error || hint ? `${htmlFor}-description` : undefined
  const control = isValidElement<Record<string, unknown>>(children)
    ? cloneElement(children, {
        'aria-describedby': descriptionId,
        'aria-invalid': error ? true : undefined
      })
    : children
  return (
    <div className="grid gap-1.5">
      <label className="text-xs font-semibold text-foreground" htmlFor={htmlFor}>{label}</label>
      {control}
      {error ? <p className="text-xs text-danger" id={descriptionId} role="alert">{error}</p> : null}
      {!error && hint ? <p className="text-xs text-muted-foreground" id={descriptionId}>{hint}</p> : null}
    </div>
  )
}

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger

export function DialogContent({ className, children, title, description }: {
  className?: string
  children: ReactNode
  title: string
  description?: string
}): React.JSX.Element {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-scrim motion-safe:animate-in motion-reduce:animate-none" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 outline-none',
          'motion-safe:animate-in motion-reduce:animate-none',
          className
        )}
      >
        <div className="mb-5 pr-8">
          <DialogPrimitive.Title className="text-base font-bold text-foreground">{title}</DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="mt-1 text-sm leading-6 text-muted-foreground">
              {description}
            </DialogPrimitive.Description>
          ) : null}
        </div>
        {children}
        <DialogPrimitive.Close asChild>
          <Button aria-label="关闭对话框" className="absolute right-3 top-3" size="icon" variant="ghost">
            <X aria-hidden="true" className="size-4" />
          </Button>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export const DialogClose = DialogPrimitive.Close
export const DropdownMenu = DropdownMenuPrimitive.Root
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

export const DropdownMenuContent = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      className={cn('z-50 min-w-44 rounded-md border border-border bg-surface p-1 text-foreground', className)}
      sideOffset={sideOffset}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
))
DropdownMenuContent.displayName = 'DropdownMenuContent'

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      'flex min-h-8 cursor-pointer select-none items-center gap-2 rounded px-2.5 text-xs outline-none',
      'focus:bg-muted focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
      className
    )}
    {...props}
  />
))
DropdownMenuItem.displayName = 'DropdownMenuItem'
