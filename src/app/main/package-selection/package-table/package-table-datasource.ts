import { DataSource } from '@angular/cdk/collections';
import { MatPaginator, MatSort } from '@angular/material';
import { map, distinctUntilChanged, debounceTime, tap } from 'rxjs/operators';
import {
  Observable,
  merge,
  Subscription,
  BehaviorSubject,
  Subject
} from 'rxjs';
import { FormControl } from '@angular/forms';
import { PreferencesService } from '../../../core/services/preferences.service';
import {
  PackageService,
  SelectablePackage
} from '../../services/package.service';
import { HumanizePipe } from '../../../shared/humanize.pipe';

export const calcPackageDirty = (pkg: SelectablePackage, mutate = true) => {
  let dirty: boolean;
  if (pkg.selected && pkg.selectedVersion) {
    dirty =
      !pkg.installedVersion ||
      pkg.selectedVersion.version.compare(pkg.installedVersion.version) !== 0;
  } else {
    dirty = !!pkg.installedVersion;
  }

  if (mutate) pkg.dirty = dirty;

  return dirty;
};

/**
 * Data source for the PackageTable view. This class should
 * encapsulate all logic for fetching and manipulating the displayed data
 * (including sorting, pagination, and filtering).
 */
export class PackageTableDataSource extends DataSource<SelectablePackage> {
  private dataSource = new BehaviorSubject<SelectablePackage[]>([]);
  data: SelectablePackage[];
  filteredData: SelectablePackage[];

  private loadingSource = new BehaviorSubject<boolean>(false);
  public loading$ = this.loadingSource
    .asObservable()
    .pipe(distinctUntilChanged());

  private changedSource = new Subject<SelectablePackage[]>();
  /** An event triggered when dataset changes */
  public changed = this.changedSource.asObservable();

  private subscription = new Subscription();

  constructor(
    private paginator: MatPaginator,
    private sort: MatSort,
    private filter: FormControl,
    private packages: PackageService,
    private prefs: PreferencesService
  ) {
    super();
    this.dataSource.subscribe(data => {
      this.data = data;
      this.filteredData = sortPackages(
        this.getFilteredData(data),
        this.sort.active || 'updated',
        false,
        this.prefs.get('respectPinned')
      );
      this.paginator.length = this.filteredData.length;
    });
  }

  /**
   * Connect this data source to the table. The table will only update when
   * the returned stream emits new items.
   * @returns A stream of the items to be rendered.
   */
  connect(): Observable<SelectablePackage[]> {
    // Combine everything that affects the rendered data into one update
    // stream for the data-table to consume.
    const dataMutations = [
      this.dataSource,
      this.paginator.page,
      this.sort.sortChange,
      this.filter.valueChanges.pipe(
        distinctUntilChanged(),
        debounceTime(100)
      )
    ];

    this.subscription.add(
      this.packages.allPackages$.subscribe(packages => {
        if (packages) {
          this.dataSource.next(packages);
          this.loadingSource.next(false);
        } else {
          this.loadingSource.next(true);
        }
      })
    );

    this.subscription.add(
      this.filter.valueChanges.subscribe(() => {
        this.filteredData = sortPackages(
          this.getFilteredData(this.data),
          this.sort.active || 'updated',
          false,
          this.prefs.get('respectPinned')
        );
        this.paginator.length = this.filteredData.length;
      })
    );

    return merge(...dataMutations).pipe(
      tap(() => {
        this.changedSource.next(this.data);
      }),
      map(() => {
        return this.getPagedData(this.getSortedData([...this.filteredData]));
      })
    );
  }

  /**
   *  Called when the table is being destroyed. Use this function, to clean up
   * any open connections or free any held resources that were set up during connect.
   */
  disconnect() {
    this.subscription.unsubscribe();
  }

  hasData() {
    return Array.isArray(this.data) && this.data.length > 0;
  }

  /**
   * Paginate the data (client-side). If you're using server-side pagination,
   * this would be replaced by requesting the appropriate data from the server.
   */
  private getPagedData(data: SelectablePackage[]): SelectablePackage[] {
    const startIndex = this.paginator.pageIndex * this.paginator.pageSize;
    return data.splice(startIndex, this.paginator.pageSize);
  }

  /**
   * Sort the data (client-side). If you're using server-side sorting,
   * this would be replaced by requesting the appropriate data from the server.
   */
  private getSortedData(data: SelectablePackage[]): SelectablePackage[] {
    if (!this.sort.active || this.sort.direction === '') {
      return data;
    }

    const isAsc = this.sort.direction === 'asc';
    return sortPackages(
      data,
      this.sort.active,
      isAsc,
      this.prefs.get('respectPinned')
    );
  }

  private getFilteredData(data: SelectablePackage[]): SelectablePackage[] {
    const filterText = (this.filter.value as string).toLowerCase();
    if (filterText && filterText.length > 0) {
      return data.filter(
        pkg =>
          new HumanizePipe()
            .transform(pkg.name, this.prefs.get('humanizePackageNames'))
            .toLowerCase()
            .includes(filterText) ||
          new HumanizePipe()
            .transform(pkg.owner, this.prefs.get('humanizePackageNames'))
            .toLowerCase()
            .includes(filterText) ||
          pkg.latestVersion.description.toLocaleLowerCase().includes(filterText)
      );
    } else {
      return data;
    }
  }
}

function sortPackages(
  data: SelectablePackage[],
  by: string,
  isAsc: boolean,
  respectPinned: boolean
): SelectablePackage[] {
  return data.sort((a, b) => {
    // todo put preference check here
    if (respectPinned) {
      // if at least on is pinned and they aren't both pinned
      // too bad js doesn't have an XOR
      if ((a.isPinned || b.isPinned) && a.isPinned !== b.isPinned) {
        return a.isPinned ? -1 : 1;
      }
    }
    switch (by) {
      case 'name':
        return compare(a.name, b.name, isAsc);
      case 'id':
        return compare(a.uuid4, b.uuid4, isAsc);
      case 'author':
        return compare(a.owner, b.owner, isAsc);
      case 'updated':
        return compare(a.dateUpdated, b.dateUpdated, isAsc);
      case 'select':
        return compare(!!a.selected, !!b.selected, !isAsc);
      case 'downloads':
        return compare(a.totalDownloads, b.totalDownloads, isAsc);
      default:
        return 0;
    }
  });
}

/** Simple sort comparator for example ID/Name columns (for client-side sorting). */
function compare(a: any, b: any, isAsc: boolean) {
  if (typeof a === 'string') {
    a = a.toUpperCase();
  }
  if (typeof b === 'string') {
    b = b.toUpperCase();
  }
  return (a < b ? -1 : 1) * (isAsc ? 1 : -1);
}
