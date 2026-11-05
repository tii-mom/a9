import type { DataSource } from '@shared/types';
import { chainSource } from './chain';
import { demoSource } from './demo';
import type { MarketSource } from './types';

export type { MarketSource } from './types';

export function getSource(dataSource: DataSource): MarketSource {
  return dataSource === 'chain' ? chainSource : demoSource;
}
