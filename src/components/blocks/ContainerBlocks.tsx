import type { ReactNode } from 'react';
import type { Block, CardBlock, SectionBlock } from '../../lib/blocks/schema';
import { imageSizeAttrs } from '../../lib/blocks/schema';
import type { IconName } from '../../lib/blocks/icons';

interface ContainerViewProps<B> {
  block: B;
  renderBlocks: (blocks: Block[]) => ReactNode;
  renderInline: (text: string) => ReactNode;
  renderIcon: (name: IconName) => ReactNode;
}

/** Section padding when none is set: a surface gets breathing room, a bare band stays flush with the text. */
export function sectionPadding(block: SectionBlock): NonNullable<SectionBlock['padding']> {
  return block.padding ?? (block.surface === 'none' ? 'none' : 'md');
}

/** Top-level band in one reading lane (`zb-lane-*`); the lane only widens on pages that opt into lanes. */
export function SectionView({ block, renderBlocks }: Omit<ContainerViewProps<SectionBlock>, 'renderInline' | 'renderIcon'>) {
  const className = `zb-section zb-lane-${block.width} zb-surface-${block.surface} zb-pad-${sectionPadding(block)}`;
  return <section id={block.anchor} className={className}>{renderBlocks(block.blocks)}</section>;
}

export function CardView({ block, renderBlocks, renderInline, renderIcon }: ContainerViewProps<CardBlock>) {
  const className = [
    'zb-card', `zb-card-${block.variant}`, `zb-card-align-${block.align ?? 'start'}`, block.accent ? `zb-accent-${block.accent}` : '',
  ].filter(Boolean).join(' ');
  const hasBody = Boolean(block.icon || block.title || block.footer) || block.blocks.length > 0;
  return (
    <div className={className}>
      {block.image && (
        <img className="zb-card-media" src={block.image.url} alt={block.image.alt} loading="lazy" decoding="async" {...imageSizeAttrs(block.image)} />
      )}
      {hasBody && <div className="zb-card-body">
        {(block.icon || block.title) && (
          <div className="zb-card-head">
            {block.icon && <span className="zb-card-icon" aria-hidden="true">{renderIcon(block.icon)}</span>}
            {block.title && <h3 className="zb-card-title">{renderInline(block.title)}</h3>}
          </div>
        )}
        {block.blocks.length > 0 && <div className="zb-card-content">{renderBlocks(block.blocks)}</div>}
        {block.footer && <div className="zb-card-footer">{renderInline(block.footer)}</div>}
      </div>}
    </div>
  );
}
