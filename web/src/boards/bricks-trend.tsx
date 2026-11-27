/** The `trend` brick's body: the chart of ./trend.tsx, given its parameters and the chip for a ticket. */
import { ticketChip, words, type BodyProps } from './brick-kit';
import { Trend as Chart } from './trend';

export const Trend = ({ params, form }: BodyProps) => <Chart project={words(params.project)} days={Number(params.days) || 30} form={form} chip={ticketChip} />;
