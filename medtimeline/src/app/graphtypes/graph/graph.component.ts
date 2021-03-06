// Copyright 2018 Verily Life Sciences Inc.
//
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

import {AfterViewInit, Input, OnChanges, SimpleChanges} from '@angular/core';
import {DomSanitizer} from '@angular/platform-browser';
import * as c3 from 'c3';
import * as d3 from 'd3';
import {Color} from 'd3';
import {DateTime, Interval} from 'luxon';
import {GraphData} from 'src/app/graphdatatypes/graphdata';
import {LabeledSeries} from 'src/app/graphdatatypes/labeled-series';
import {LineGraphData} from 'src/app/graphdatatypes/linegraphdata';
import {v4 as uuid} from 'uuid';

import {DisplayGrouping} from '../../clinicalconcepts/display-grouping';
import {getTickMarksForXAxis} from '../../date_utils';
import {StandardTooltip} from '../tooltips/tooltip';

export enum ChartType {
  SCATTER,
  LINE,
  STEP,
  MICROBIO
}

const BASE_CHART_HEIGHT_PX = 150;

// The maximum characters for a y-axis tick label.
export const Y_AXIS_TICK_MAX = 12;

/**
 * Displays a graph. T is the data type the graph is equipped to display.
 */
export abstract class GraphComponent<T extends GraphData> implements
    OnChanges, AfterViewInit {
  // The x-axis eventlines to display on the chart.
  @Input() eventlines: Array<{[key: string]: number | string}>;
  // Over which time interval the card should display data, stored in UTC time.
  @Input() dateRange: Interval;
  @Input() data: T;
  // The y-axis label to display.
  @Input() axisLabel: string;

  // A unique identifier for the element to bind the graph to.
  chartDivId: string;

  // What type of chart this is. Line chart by default.
  chartType: ChartType = ChartType.LINE;

  // Maps for making a custom legend. We assume that the custom legend does not
  // change over the lifetime of this rendered graph.
  private customLegendSet = false;

  // These two variables are different views on the data held in
  // seriesTodisplayGroup. We need to hold them in separate maps for more
  // efficient access during legend interaction.
  readonly displayGroupToSeries = new Map<DisplayGrouping, string[]>();

  // Indicating whether are not there are any data points for the current time
  // interval.
  noDataPointsInDateRange: boolean;

  // The rendered chart so that you can apply functions to it.
  chart: c3.ChartAPI;

  // The rendered chart's configuration.
  chartConfiguration: c3.ChartConfiguration;

  // The y-axis configuration for the chart.
  yAxisConfig: c3.YAxisConfiguration = {};

  // The x-axis configuration for the chart.
  xAxisConfig: c3.XAxisConfiguration;

  // A map containing a color for each series displayed on the graph.
  colorsMap: {[key: string]: string} = {};

  // The default chart type for this chart.
  chartTypeString: string;

  // We hold the values of yAxis tick labels and set the values as empty strings
  // during setup, so that the y axis does not get shifted while getting
  // displayed.
  yAxisTickDisplayValues: string[];

  labels: string[] = [];

  constructor(readonly sanitizer: DomSanitizer) {
    // Generate a unique ID for this chart.
    const chartId = uuid();
    // Replace the dashes in the UUID to meet HTML requirements.
    const re = /\-/gi;
    this.chartDivId = 'chart' + chartId.replace(re, '');
  }

  /*
   * Returns whether or not there are any data points in the series that fall
   * inside the date range provided.
   * @param series The LabeledSeries to find data points in the date range.
   * @param dateRange The date range in which to see if there are any data
   *     points.
   */
  static dataPointsInRange(series: LabeledSeries[], dateRange: Interval):
      boolean {
    const entireRange = Interval.fromDateTimes(
        dateRange.start.toLocal().startOf('day'),
        dateRange.end.toLocal().endOf('day'));
    for (const s of series) {
      for (const x of s.xValues) {
        if (entireRange.contains(x)) {
          return true;
        }
      }
    }
    return false;
  }

  // The chart can't find the element to bind to until after the view is
  // initialized so we need to regenerate the chart here.
  ngAfterViewInit() {
    this.generateFromScratch();
  }

  // Any time the bound data changes, we need to adjust the configurations of
  // the chart. If there is not yet a chart configuration, we generate the chart
  // from scratch.
  ngOnChanges(changes: SimpleChanges) {
    // Only change what needs to be changed.
    if (this.chartConfiguration) {
      if (changes.data) {
        this.dataChanged();
      }
      if (changes.dateRange) {
        this.adjustXAxis();
      }
      if (changes.eventlines) {
        this.updateEventlines();
      }
      this.chart = c3.generate(this.chartConfiguration);
      this.adjustStyle();
    } else {
      this.generateFromScratch();
    }
  }

  // If there is not yet a chart or chart configuration, configure and generate
  // the chart to display.
  generateFromScratch() {
    if (this.data && this.dateRange) {
      this.generateChart();
      this.chart = c3.generate(this.chartConfiguration);
      this.adjustStyle();
    }
  }

  // Called if the data to be displayed on the chart is changed.
  dataChanged() {
    // Y axis configuration depends on the data values.
    this.adjustYAxisConfig();
    // The colors displayed depends on the data values.
    this.adjustColorMap();
    // Update the data points displayed on the chart.
    this.updateData();
    // Adjust the y-axis ticks and wrapping for the chart, also dependent on the
    // data values.
    this.adjustDataDependent();
  }

  // Called after some, or all, parts of the chart are changed, to ensure that
  // the style stays.
  adjustStyle() {
    this.showNoData();
    this.wrapYAxisLabels();
  }

  // Add an overlay indicating that there are no data points in the date
  // range.
  showNoData() {
    if (this.noDataPointsInDateRange) {
      const emptyContainer =
          d3.select('#' + this.chartDivId).select('.c3-text.c3-empty');
      emptyContainer.text(
          'No data for ' + this.dateRange.start.toLocaleString() + '-' +
          this.dateRange.end.toLocaleString());
      emptyContainer.attr('class', 'c3-text c3-empty noData');
      // We set the opacity of the y-axis ticks of empty charts to 0 after
      // setting the tick values. We do this instead of not displaying the
      // y-axis altogether to ensure that the left padding of the chart is
      // aligned with all other charts.
      const yAxisTicks = d3.select('#' + this.chartDivId)
                             .selectAll('.c3-axis-y')
                             .selectAll('.tick')
                             .style('opacity', 0);
    }
  }

  /**
   * Sets up a generalized c3.ChartConfig for the data passed in. See the
   * type definition at:
   * https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/types/c3/index.d.ts
   * @param maxXTicks: The maximum number of tick-marks to include on the x-axis
   */
  generateBasicChart(maxXTicks = 10) {
    this.adjustXAxis(maxXTicks);
    this.adjustColorMap();

    this.chartTypeString = 'line';

    if (this.chartType === ChartType.SCATTER) {
      this.chartTypeString = 'scatter';
    } else if (this.chartType !== ChartType.LINE) {
      throw Error('Unsupported chart type: ' + this.chartType);
    }

    // Show the y-axis label on the chart.
    this.yAxisConfig['label'] = {
      text: (this.axisLabel ? this.axisLabel : ''),
      position: 'outer-middle'
    };

    const gridlines: any = this.eventlines ? this.eventlines : [];
    const self = this;
    const chartConfiguration = {
      bindto: '#' + this.chartDivId,
      size: {height: BASE_CHART_HEIGHT_PX},
      data: {
        columns: this.data.c3DisplayConfiguration.allColumns,
        xs: this.data.c3DisplayConfiguration.columnMap,
        type: this.chartTypeString,
        colors: this.colorsMap,
      },
      regions: this.data.xRegions,
      axis: {x: this.xAxisConfig, y: this.yAxisConfig},
      legend: {show: false},  // There's always a custom legend
      line: {connectNull: false},
      onrendered: function() {
        self.boldDates();
        self.adjustStyle();
        self.fixOpacity();
        self.onRendered(this);
      },
      grid: {x: {lines: gridlines}},
      tooltip: this.setTooltip()
    };

    // chartConfiguration['tooltip'] = this.setTooltip();

    this.setCustomLegend(
        this.data.c3DisplayConfiguration.ySeriesLabelToDisplayGroup);
    this.chartConfiguration = chartConfiguration;
  }

  // If only the data is updated, there is no need to re-configure the chart
  // configurations that stay constant. Instead, just rework the
  // ChartConfiguration's data field.
  updateData() {
    this.chartConfiguration.data = {
      columns: this.data.c3DisplayConfiguration.allColumns,
      xs: this.data.c3DisplayConfiguration.columnMap,
      type: this.chartTypeString,
      colors: this.colorsMap,
    };
  }

  // Update any event lines from any CustomTimeline that should be shown on the
  // chart.
  updateEventlines() {
    const gridlines: any = this.eventlines ? this.eventlines : [];
    this.chartConfiguration.grid.x = {lines: gridlines};
  }

  // Adjust the color map for the data belonging to the chart.
  adjustColorMap() {
    for (const key of Object.keys(this.data.c3DisplayConfiguration.columnMap)) {
      if (this.data.c3DisplayConfiguration.ySeriesLabelToDisplayGroup.get(
              key)) {
        const lookupColor: Color =
            this.data.c3DisplayConfiguration.ySeriesLabelToDisplayGroup.get(key)
                .fill;
        this.colorsMap[key] = lookupColor.toString();
      }
    }
  }

  /**
   * If the date range is changed, adjust the x-axis tick marks displayed. This
   * method does not need to be called otherwise, as the x-axis should stay
   * constant unless the date range is changed.
   * @param maxXTicks The maximum number of labeled ticks to display. By
   *     default, any date range lasting shorter than maxXTicks will show tick
   *     marks with labels at each 24-hour mark, and tick marks without labels
   *     at 12-hour marks.
   */
  adjustXAxis(maxXTicks = 10) {
    const daysInRange = getTickMarksForXAxis(this.dateRange, true);
    // The ticks with labels displayed.
    const ticksLabels = new Array<DateTime>();
    // All ticks displayed.
    let ticks = new Array<DateTime>();
    if (Math.floor(daysInRange.length / 2) <= maxXTicks) {
      // Ticks are separated by 1 day intervals, in which case we show ticks
      // with no labels at the 12-hour mark.
      ticks = daysInRange;
      for (let i = 0; i < daysInRange.length; i += 2) {
        ticksLabels.push(daysInRange[i]);
      }
    } else {
      // Ticks are separated by intervals > 1 day, in which case we show ticks
      // with no labels at the day mark.
      const iteration = Math.ceil(daysInRange.length / maxXTicks);
      ticksLabels.push(daysInRange[0]);
      let date = daysInRange[0];
      while (date <= this.dateRange.end) {
        date = date.plus({days: iteration});
        ticksLabels.push(date);
      }
      date = daysInRange[0];
      ticks.push(date);
      while (date <= this.dateRange.end) {
        date = date.plus({days: 1});
        ticks.push(date);
      }
    }

    this.labels = ticksLabels.map(function(x) {
      const date = x.toJSDate();
      const formatTime = d3.timeFormat('%m/%d %H:%M');
      return formatTime(date);
    });


    this.xAxisConfig = {
      type: 'timeseries',
      min: this.dateRange.start.toLocal().startOf('day').toJSDate(),
      max: this.dateRange.end.toLocal().endOf('day').toJSDate(),
      localtime: true,
      tick: {
        // To reduce ambiguity we include the hour as well.
        format: '%m/%d %H:%M',
        multiline: true,
        fit: true,
        values: ticks.map(x => Number(x))
      },
      padding: {left: 0, right: 0}
    };
  }

  /**
   * Sets the tooltip for the graph.
   * If the class has a tooltipMap set, then we look up the tooltip from that
   * map. If there's no tooltipMap, then we return a simple formatted tooltip
   * of just the string representing the data plus the appropriate units for
   * a linegraph, or just the unedited value if it's a different kind of graph.
   */
  setTooltip(): {} {
    const self = this;
    if (this.data && this.data.tooltipMap) {
      return {
        contents: (
            pointData: any[], defaultTitleFormat, defaultValueFormat,
            color) => {
          // pointData will hold every point for the x-value you're hovering
          // on. We squish together all those data points preemptively in
          // our tooltip creation so that we just find the index of the
          // tooltip based on the first point's x-value.
          const value = pointData[0];
          const timestampKey =
              DateTime.fromJSDate(value.x).toMillis().toString();
          // Our data class may provide a tooltip key function that will
          // get the correct identifier from the data point. If it does,
          // we'll use that, but by default, the key is the timestamp
          // of the data point.
          const keyToUse = this.data.tooltipKeyFn ?
              this.data.tooltipKeyFn(value) :
              timestampKey;
          // If something bad happens and we don't have a tooltip for the
          // key, return an empty string so that there will just be no
          // tooltip.
          if (!this.data.tooltipMap.has(keyToUse)) {
            return new StandardTooltip(
                       pointData, color,
                       self.data instanceof LineGraphData ? self.data.unit : '')
                .getTooltip(undefined, this.sanitizer);
          }
          return this.data.tooltipMap.get(keyToUse);
        }
      };
    } else {
      return {
        format: {
          value: (value, ratio, id, index) => {
            if (self.data instanceof LineGraphData) {
              return (
                  d3.format(',.' + self.data.precision + 'f')(value) + ' ' +
                  self.data.unit);
            }
            return value;
          }
        }
      };
    }
  }

  /**
   * Adds a shaded region on the chart across all x values, between the two
   * y values specified by yBounds.
   * @param basicChart The chart to add the region to
   * @param yBounds The y-bounds of the region to display
   */
  addYRegionOnChart(basicChart: c3.ChartConfiguration, yBounds: [
    number, number
  ]): c3.ChartConfiguration {
    if (!basicChart.axis.y.tick) {
      basicChart.axis.y['tick'] = {};
    }

    basicChart.axis.y.tick['values'] = yBounds;
    if (!basicChart['regions']) {
      basicChart['regions'] = [];
    }
    basicChart['regions'].push({axis: 'y', start: yBounds[0], end: yBounds[1]});
    return basicChart;
  }

  /**
   * Sets a custom legend.
   * To simplify rendering logic, we assume that we only set up a custom legend
   * once over the lifetime of this graph.
   *
   * @param customLegendMap If you want a custom legend grouping multiple series
   *   together, pass a map with keys of
   *   series names and values of the ClinicalConcepts they should correspond
   *   to in a legend.
   */
  setCustomLegend(seriesToDisplayGroup: Map<string, DisplayGrouping>) {
    if (!this.customLegendSet) {
      for (const [seriesLbl, displayGroup] of Array.from(
               seriesToDisplayGroup.entries())) {
        if (!this.displayGroupToSeries.has(displayGroup)) {
          this.displayGroupToSeries.set(displayGroup, new Array(seriesLbl));
        } else {
          const appendedArray =
              this.displayGroupToSeries.get(displayGroup).concat(seriesLbl);
          this.displayGroupToSeries.set(displayGroup, appendedArray);
        }
      }
      this.customLegendSet = true;
    }
  }

  focusOnDisplayGroup(displayGroup: DisplayGrouping) {
    this.chart.focus(this.displayGroupToSeries.get(displayGroup));
  }

  resetChart(displayGroup: DisplayGrouping) {
    this.chart.revert();
  }

  /**
   * Inserts wrapped y-axis tick labels.
   * TODO(b/123229731): Include this method in chart.onRendered
   */
  wrapYAxisLabels() {
    if (this.yAxisTickDisplayValues) {
      let currIndex = 0;
      const self = this;
      d3.select('#' + this.chartDivId)
          .selectAll('.c3-axis-y')
          .selectAll('.tick text')
          .each(function() {
            // Get the text element.
            const text = d3.select(this);
            // Break up the label by spaces.
            const words =
                self.yAxisTickDisplayValues[currIndex].split(/\s+/).reverse();
            let word;
            let line = [];
            const lineHeight = 10;
            // startDy is an attribute indicating how much to shift the first
            // line of the label by in the y direction. The standard dy for a
            // tick text is 3. Figure out the optimal starting dy such that half
            // of the words are displayed above the tick, and half below.
            const dyInterval = 6;
            const startDy = 3 - (Math.floor(words.length / 2) * dyInterval);
            // Insert the initial tspan.
            let tspan = text.text(null).append('tspan').attr('x', -9).attr(
                'dy', startDy);
            while (word = words.pop()) {
              line.push(word);
              tspan.text(line.join(' '));
              // Add another tspan (another line) if the label is too long.
              // We don't break up single words that are too long.
              if (tspan.text().length > Y_AXIS_TICK_MAX &&
                  tspan.text().includes(' ')) {
                // Add another line.
                line.pop();
                tspan.text(line.join(' '));
                line = [word];
                tspan =
                    text.append('tspan').attr('x', -9).attr('dy', lineHeight);
              }
            }
            // Add the remaining parts of the label to the tspan's text.
            if (line.length > 0) {
              tspan.text(line.join(' '));
            }
            currIndex++;
          });
    }
  }

  /**
   * Called every time the graph is rendered. If subclass graphs want to do
   * something special upon rendering, they can override this function.
   */
  onRendered(graphObject): void {}

  /**
   * Bolds the date portion of each x-axis tick label, and removes unnecessary
   * labels.
   */
  boldDates() {
    if (this.chart) {
      const self = this;
      d3.select('#' + this.chartDivId)
          .selectAll('.c3-axis-x')
          .selectAll('.tick text')
          .each(function() {
            // We get x (the x position), dy (how much to shift vertically), and
            // dx (how much to shift horiztontally) of the tspan inside text
            const dy = d3.select(this).select('tspan').attr('dy');
            const dx = d3.select(this).select('tspan').attr('dx');
            const x = d3.select(this).select('tspan').attr('x');
            const textSplit = d3.select(this).text().split(' ');
            const text = d3.select(this).text();
            const tspan = d3.select(this)
                              .text(null)
                              .append('tspan')
                              .attr('x', x)
                              .attr('dx', dx)
                              .attr('dy', dy)
                              .style('font-weight', 'bolder');
            // Only add the tick label text if it was meant to be
            // displayed.
            if (self.labels.length > 0 && self.labels.includes(text)) {
              tspan.text(
                  textSplit[0]);  // Set the 'bold' tspan's content as the date.
              d3.select(this).append('tspan').text(
                  ' ' + textSplit[1]);  // Add an additional tspan for the time.
            }
          });
    }
  }

  fixOpacity() {
    d3.select('#' + this.chartDivId).selectAll('.c3-circle').each(function(d) {
      if (d3.select(this).style('opacity') === '0.5') {
        d3.select(this).style('opacity', 1);
      }
    });
  }

  /**
   * Generates the chart specified by the extending class.
   * @param chartHeight The height of the chart in pixels.
   */
  abstract generateChart(chartHeight?: number);

  /**
   * Generates the y-axis configuration for the chart specified by the extending
   * class.
   */
  abstract adjustYAxisConfig();

  /**
   * Adjusts the data-dependent fields of the chart's configuration specified by
   * the extending class.
   */
  abstract adjustDataDependent();
}
