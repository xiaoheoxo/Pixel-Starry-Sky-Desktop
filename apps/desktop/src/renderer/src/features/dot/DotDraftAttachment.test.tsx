import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { DotDraftAttachment } from './DotDraftAttachment'

describe('Dot composer attachment preview', () => {
  const markup = (name: string) =>
    renderToStaticMarkup(
      <I18nProvider>
        <DotDraftAttachment
          entryKey="room"
          file={{ id: 'file', name, bytes: 64 }}
          open={false}
          onPreview={() => {}}
          onRemove={() => {}}
        />
      </I18nProvider>,
    )
  it('offers a separate preview and remove button for images, but not for ordinary files', () => {
    expect((markup('photo.png').match(/<button/g) ?? []).length).toBe(2)
    expect((markup('document.txt').match(/<button/g) ?? []).length).toBe(1)
  })
})
